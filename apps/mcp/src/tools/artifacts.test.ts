/**
 * `atlas_save_artifact` end to end over MCP: the SDK's client calls the tool,
 * and a fake DFAI records the REST requests it became — one when the page is
 * small, the note then chunks when it is not.
 */

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { CHUNK_BYTES, INLINE_PAGE_BYTES } from '../artifact-upload.ts';
import { AtlasClient } from '../client.ts';
import { createAtlasServer } from '../server.ts';
import { UPLOAD_LIMITS, type UploadLimits } from '../upload-limits.ts';
import {
  errorBody,
  startFakeAtlas,
  type FakeAtlas,
  type RecordedRequest,
} from '../testing/fake-atlas.ts';

const NOTE = {
  path: 'artifacts/Q3 Deck.md',
  title: 'Q3 Deck',
  type: 'artifact',
  modified: 7,
  properties: { kind: 'deck' },
  body: '',
};
const NOTE_URL = '/v1/artifacts/artifacts%2FQ3%20Deck.md/files/';
const THUMBNAIL_URL = '/v1/artifacts/artifacts%2FQ3%20Deck.md/thumbnail';

/** A small file limit for the size tests, past two chunks so the chunked path still runs. */
const TEST_FILE_BYTES = 2 * CHUNK_BYTES + 1;

let atlas: FakeAtlas;
let mcp: Client;

/** Answers as DFAI would: the note for a save or a read, the file's new length for a chunk. */
function atlasAnswer(request: RecordedRequest) {
  if (request.method === 'PUT') {
    const { base64, offset } = request.body as { base64: string; offset: number };
    const size = offset + Buffer.from(base64, 'base64').byteLength;
    const name = decodeURIComponent(request.url.slice(NOTE_URL.length));
    return { status: 201, body: { file: { path: `artifacts/q3-deck/${name}`, size } } };
  }
  return { status: request.method === 'POST' ? 201 : 200, body: { note: NOTE } };
}

/** An MCP client on a server over the fake DFAI, with DFAI's limits unless given others. */
async function connectMcp(limits?: UploadLimits): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const connect = async () => ({ baseUrl: atlas.baseUrl, token: 't' });
  await createAtlasServer(new AtlasClient({ connect }), limits).connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

/** Swaps the client for one whose server refuses files past `artifactFileBytes`. */
async function withFileLimit(artifactFileBytes: number): Promise<void> {
  await mcp.close();
  mcp = await connectMcp({ ...UPLOAD_LIMITS, artifactFileBytes });
}

beforeEach(async () => {
  atlas = await startFakeAtlas(atlasAnswer);
  mcp = await connectMcp();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await mcp.close();
  await atlas.close();
});

async function save(args: Record<string, unknown>) {
  const result = await mcp.callTool({ name: 'atlas_save_artifact', arguments: args });
  const [first] = result.content as { text: string }[];
  return { isError: result.isError === true, text: first?.text ?? '' };
}

const summary = () =>
  atlas.requests.map(({ method, url, body }) => {
    const { base64, offset } = (body ?? {}) as { base64?: string; offset?: number };
    return base64 === undefined
      ? { method, url }
      : { method, url, offset, bytes: Buffer.from(base64, 'base64').byteLength };
  });

describe('atlas_save_artifact', () => {
  it('saves a small page with its note in one POST, then has it pictured', async () => {
    const result = await save({
      title: 'Q3 Deck',
      url: 'https://claude.ai/artifact/abc',
      kind: 'deck',
      tags: ['sales'],
      html: '<h1>Q3</h1>',
    });

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ note: NOTE, files: [] });
    expect(atlas.requests.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      {
        method: 'POST',
        url: '/v1/artifacts',
        body: {
          title: 'Q3 Deck',
          url: 'https://claude.ai/artifact/abc',
          kind: 'deck',
          tags: ['sales'],
          html: '<h1>Q3</h1>',
        },
      },
      { method: 'POST', url: THUMBNAIL_URL, body: null },
    ]);
  });

  it('asks for no thumbnail when only the link is kept', async () => {
    await save({ title: 'Q3 Deck', url: 'https://claude.ai/artifact/abc' });
    expect(summary()).toEqual([{ method: 'POST', url: '/v1/artifacts' }]);
  });

  it('still answers with the note when DFAI cannot picture the copy, saying why', async () => {
    atlas.respondWith((request) =>
      request.url === THUMBNAIL_URL
        ? { status: 422, body: errorBody('thumbnail_failed', 'thumbnails are made on macOS only') }
        : atlasAnswer(request),
    );
    const result = await save({ title: 'Q3 Deck', html: '<h1>Q3</h1>' });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({
      note: NOTE,
      files: [],
      thumbnail: 'thumbnail_failed: thumbnails are made on macOS only',
    });
    expect(summary().at(-1)).toEqual({ method: 'GET', url: '/v1/notes/artifacts%2FQ3%20Deck.md' });
  });

  it('sends a page too large for one request as chunks after the note, then has it pictured', async () => {
    const html = `<p>${'é'.repeat(INLINE_PAGE_BYTES)}</p>`;
    const size = Buffer.byteLength(html, 'utf8');

    const result = await save({ title: 'Q3 Deck', html });

    expect(result.isError).toBe(false);
    expect(summary()).toEqual([
      { method: 'POST', url: '/v1/artifacts' },
      { method: 'PUT', url: `${NOTE_URL}index.html`, offset: 0, bytes: CHUNK_BYTES },
      { method: 'PUT', url: `${NOTE_URL}index.html`, offset: CHUNK_BYTES, bytes: CHUNK_BYTES },
      {
        method: 'PUT',
        url: `${NOTE_URL}index.html`,
        offset: 2 * CHUNK_BYTES,
        bytes: size - 2 * CHUNK_BYTES,
      },
      { method: 'POST', url: THUMBNAIL_URL },
    ]);
    expect(atlas.requests[0]?.body).not.toHaveProperty('html');
    // Every request fits the host's 1 MiB body cap.
    for (const request of atlas.requests) {
      expect(JSON.stringify(request.body ?? '').length).toBeLessThan(1024 * 1024);
    }
    expect(JSON.parse(result.text).files).toEqual([{ path: 'artifacts/q3-deck/index.html', size }]);
  });

  it("sends the page's other files, text and base64, each named as one encoded segment", async () => {
    await save({
      title: 'Q3 Deck',
      html: '<img src="img/logo.png">',
      files: [
        { name: 'img/logo.png', base64: 'iVBO\nRw==' },
        { name: 'app.css', text: 'body{}' },
      ],
    });
    expect(summary()).toEqual([
      { method: 'POST', url: '/v1/artifacts' },
      { method: 'PUT', url: `${NOTE_URL}img%2Flogo.png`, offset: 0, bytes: 4 },
      { method: 'PUT', url: `${NOTE_URL}app.css`, offset: 0, bytes: 6 },
      { method: 'POST', url: THUMBNAIL_URL },
    ]);
  });

  it('refuses a file that is not valid, before saving anything', async () => {
    for (const bad of [{ name: 'a.png', base64: 'not base64!' }, { name: 'a.css' }]) {
      const result = await save({ title: 'Q3 Deck', files: [bad] });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/a\.(png|css)/);
    }
    expect(atlas.requests).toEqual([]);
  });

  it("holds files to DFAI's 32 MB limit unless the server is given another", () => {
    expect(UPLOAD_LIMITS.artifactFileBytes).toBe(33_554_432);
  });

  it('refuses a base64 file one byte past the limit by its size, before saving anything', async () => {
    await withFileLimit(TEST_FILE_BYTES);
    const base64 = Buffer.alloc(TEST_FILE_BYTES + 1).toString('base64');

    const result = await save({ title: 'Q3 Deck', files: [{ name: 'a.png', base64 }] });

    expect(result).toEqual({
      isError: true,
      text: 'a.png is larger than the 32 MB a file of a copy can be.',
    });
    expect(atlas.requests).toEqual([]);
  });

  it('sends a base64 file of exactly the limit whole, in chunks', async () => {
    await withFileLimit(TEST_FILE_BYTES);
    const base64 = Buffer.alloc(TEST_FILE_BYTES).toString('base64');

    const result = await save({ title: 'Q3 Deck', files: [{ name: 'a.png', base64 }] });

    expect(result.isError).toBe(false);
    const sent = summary().filter(({ url }) => url === `${NOTE_URL}a.png`);
    expect(sent.map(({ offset }) => offset)).toEqual([0, CHUNK_BYTES, 2 * CHUNK_BYTES]);
    expect(sent.reduce((total, chunk) => total + (chunk.bytes ?? 0), 0)).toBe(TEST_FILE_BYTES);
  });

  it('says the note was saved when a file of it was refused', async () => {
    atlas.respondWith((request) =>
      request.method === 'PUT'
        ? { status: 400, body: errorBody('invalid', 'only html, css… files can be saved') }
        : atlasAnswer(request),
    );
    const result = await save({ title: 'Q3 Deck', files: [{ name: 'run.sh', text: 'x' }] });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "The artifact's note was saved at artifacts/Q3 Deck.md, but run.sh was not: " +
        'invalid: only html, css… files can be saved',
    );
  });

  it('refuses a kind DFAI does not have before any request is made', async () => {
    const result = await save({ title: 'x', kind: 'slides' });
    expect(result.isError).toBe(true);
    expect(atlas.requests).toEqual([]);
  });
});
