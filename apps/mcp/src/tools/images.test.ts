/**
 * `atlas_add_image` end to end over MCP: the image goes up whole, or as an
 * upload in chunks that DFAI puts in place with the last, then its markdown
 * is appended to the note.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { CHUNK_BYTES } from '../artifact-upload.ts';
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
  path: 'Work/Plan.md',
  title: 'Plan',
  type: null,
  modified: 3,
  properties: {},
  body: '',
};
const IMAGES_URL = '/v1/notes/Work%2FPlan.md/images/';
const APPEND_URL = '/v1/notes/Work%2FPlan.md/append';
/** A small image limit for the size tests, past two chunks so the chunked path still runs. */
const TEST_IMAGE_BYTES = 2 * CHUNK_BYTES + 1;

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let atlas: FakeAtlas;
let mcp: Client;
let folder: string;

/**
 * As DFAI answers: an upload's size so far until its last chunk, then the
 * image saved as "<name> 2" (the name was taken).
 */
function atlasAnswer(request: RecordedRequest) {
  if (request.method === 'PUT') {
    const {
      base64,
      offset = 0,
      last = true,
    } = request.body as { base64: string; offset?: number; last?: boolean };
    const size = offset + Buffer.from(base64, 'base64').byteLength;
    if (!last) return { status: offset === 0 ? 202 : 200, body: { upload: { id: 'u1', size } } };
    const asked = decodeURIComponent(request.url.slice(IMAGES_URL.length));
    const name = asked.replace(/\.png$/, ' 2.png');
    const path = `attachments/${name}`;
    const src = `../attachments/${encodeURIComponent(name)}`;
    return {
      status: 201,
      body: { image: { path, size, src, alt: 'shot', markdown: `![shot](${src})` } },
    };
  }
  return { status: 200, body: { note: NOTE } };
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

/** Swaps the client for one whose server refuses images past `imageBytes`. */
async function withImageLimit(imageBytes: number): Promise<void> {
  await mcp.close();
  mcp = await connectMcp({ ...UPLOAD_LIMITS, imageBytes });
}

beforeEach(async () => {
  atlas = await startFakeAtlas(atlasAnswer);
  folder = await mkdtemp(join(tmpdir(), 'atlas-mcp-image-'));
  mcp = await connectMcp();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await mcp.close();
  await atlas.close();
  await rm(folder, { recursive: true, force: true });
});

async function addImage(args: Record<string, unknown>) {
  const result = await mcp.callTool({ name: 'atlas_add_image', arguments: args });
  const [first] = result.content as { text: string }[];
  return { isError: result.isError === true, text: first?.text ?? '' };
}

const summary = () =>
  atlas.requests.map(({ method, url, body }) => {
    const { base64, offset, markdown, upload, last } = (body ?? {}) as {
      base64?: string;
      offset?: number;
      markdown?: string;
      upload?: string;
      last?: boolean;
    };
    if (markdown !== undefined) return { method, url, markdown };
    const bytes = Buffer.from(base64 ?? '', 'base64').byteLength;
    return { method, url, offset, upload, last, bytes };
  });

describe('atlas_add_image', () => {
  it('sends a large file from disk as an upload in chunks, the last saying so, then appends it', async () => {
    const size = 2 * CHUNK_BYTES + 10;
    const file = join(folder, 'shot.png');
    await writeFile(file, Buffer.concat([PNG_HEAD, Buffer.alloc(size - PNG_HEAD.byteLength)]));

    const result = await addImage({ path: 'Work/Plan.md', file });

    expect(result.isError).toBe(false);
    const url = `${IMAGES_URL}shot.png`;
    expect(summary()).toEqual([
      { method: 'PUT', url, last: false, bytes: CHUNK_BYTES },
      { method: 'PUT', url, offset: CHUNK_BYTES, upload: 'u1', last: false, bytes: CHUNK_BYTES },
      { method: 'PUT', url, offset: 2 * CHUNK_BYTES, upload: 'u1', last: true, bytes: 10 },
      { method: 'POST', url: APPEND_URL, markdown: '![shot](../attachments/shot%202.png)' },
    ]);
    for (const request of atlas.requests) {
      expect(JSON.stringify(request.body ?? '').length).toBeLessThan(1024 * 1024);
    }
    expect(JSON.parse(result.text)).toMatchObject({
      image: { path: 'attachments/shot 2.png', size },
      note: { path: 'Work/Plan.md' },
    });
  });

  it('takes base64 with a name, and only saves it when insert is false', async () => {
    const result = await addImage({
      path: 'Work/Plan.md',
      base64: PNG_HEAD.toString('base64'),
      name: 'chart.png',
      insert: false,
    });

    expect(result.isError).toBe(false);
    expect(summary()).toEqual([{ method: 'PUT', url: `${IMAGES_URL}chart.png`, bytes: 8 }]);
    expect(JSON.parse(result.text)).not.toHaveProperty('note');
  });

  it.each([
    ['neither file nor base64', {}],
    ['both file and base64', { file: '/tmp/a.png', base64: 'eA==', name: 'a.png' }],
    ['base64 with no name', { base64: 'eA==' }],
    ['base64 that is not base64', { base64: 'not base64!', name: 'a.png' }],
    ['a file that is not there', { file: '/nowhere/at/all.png' }],
  ])('refuses %s before any request is made', async (_why, args) => {
    const result = await addImage({ path: 'Work/Plan.md', ...args });
    expect(result.isError).toBe(true);
    expect(atlas.requests).toEqual([]);
  });

  it("holds images to DFAI's 20 MB limit unless the server is given another", () => {
    expect(UPLOAD_LIMITS.imageBytes).toBe(20_971_520);
  });

  it('refuses base64 one byte past the limit by its size, before any request, logging nothing', async () => {
    await withImageLimit(TEST_IMAGE_BYTES);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const base64 = Buffer.alloc(TEST_IMAGE_BYTES + 1).toString('base64');

    const result = await addImage({ path: 'Work/Plan.md', base64, name: 'a.png' });

    expect(result).toEqual({
      isError: true,
      text: 'a.png is larger than the 20 MB an image in a note can be.',
    });
    expect(errors).not.toHaveBeenCalled();
    expect(atlas.requests).toEqual([]);
  });

  it('sends base64 of exactly the limit whole, as an upload in chunks', async () => {
    await withImageLimit(TEST_IMAGE_BYTES);
    const base64 = Buffer.alloc(TEST_IMAGE_BYTES).toString('base64');

    const result = await addImage({ path: 'Work/Plan.md', base64, name: 'a.png', insert: false });

    expect(result.isError).toBe(false);
    const sent = summary().filter(({ method }) => method === 'PUT');
    expect(sent.map((chunk) => ('last' in chunk ? chunk.last : undefined))).toEqual([
      false,
      false,
      true,
    ]);
    expect(sent.reduce((total, chunk) => total + ('bytes' in chunk ? chunk.bytes : 0), 0)).toBe(
      TEST_IMAGE_BYTES,
    );
  });

  it.each([['shot.svg'], ['shot']])(
    'refuses a name (%s) that would save a real image on disk as another kind',
    async (name) => {
      const file = join(folder, 'shot.png');
      await writeFile(file, PNG_HEAD);

      const result = await addImage({ path: 'Work/Plan.md', file, name });

      expect(result).toEqual({
        isError: true,
        text: "name must keep the file's own extension (.png): it cannot change its kind",
      });
      expect(atlas.requests).toEqual([]);
    },
  );

  it('says where the image was saved when the note would not take it', async () => {
    atlas.respondWith((request) =>
      request.method === 'POST'
        ? {
            status: 409,
            body: errorBody('unsaved_in_app', 'Work/Plan.md is open with unsaved edits'),
          }
        : atlasAnswer(request),
    );

    const result = await addImage({
      path: 'Work/Plan.md',
      base64: PNG_HEAD.toString('base64'),
      name: 'a.png',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'The image was saved at attachments/a 2.png, but not added to the note: unsaved_in_app: ' +
        'Work/Plan.md is open with unsaved edits. Add ![shot](../attachments/a%202.png) to it yourself.',
    );
  });

  it('passes on why DFAI refused the image, adding nothing to the note', async () => {
    atlas.respondWith(() => ({
      status: 400,
      body: errorBody('invalid', '“a.png” does not start the way a PNG image does.'),
    }));

    const result = await addImage({ path: 'Work/Plan.md', base64: 'eA==', name: 'a.png' });

    expect(result).toEqual({
      isError: true,
      text: 'invalid: “a.png” does not start the way a PNG image does.',
    });
    expect(atlas.requests.map(({ method }) => method)).toEqual(['PUT']);
  });
});
