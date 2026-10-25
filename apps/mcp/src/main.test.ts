/**
 * The real process, over real stdio: `node src/main.ts` started by the SDK's
 * stdio client, finding a fake DFAI through a connection file on disk. This is
 * what Claude Code and Claude Desktop do; if anything but protocol reached
 * stdout, the client would fail to parse it.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { errorBody, startFakeAtlas, type FakeAtlas } from './testing/fake-atlas.ts';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));

let atlas: FakeAtlas;
let dir: string;
let connectionFile: string;
let mcp: Client;

const writeConnection = (token: string, enabled = true) =>
  writeFile(connectionFile, JSON.stringify({ port: atlas.port, token, version: 1, enabled }));

beforeEach(async () => {
  atlas = await startFakeAtlas((request) =>
    request.authorization === 'Bearer current'
      ? { status: 200, body: { hits: [] } }
      : { status: 401, body: errorBody('unauthorized', 'Wrong token.') },
  );
  dir = await mkdtemp(join(tmpdir(), 'atlas-mcp-'));
  connectionFile = join(dir, 'api.json');
  mcp = new Client({ name: 'stdio-test', version: '1.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MAIN],
      env: { ATLAS_CONNECTION_FILE: connectionFile, PATH: process.env['PATH'] ?? '' },
      stderr: 'pipe',
    }),
  );
});

afterEach(async () => {
  await mcp.close();
  await atlas.close();
  await rm(dir, { recursive: true, force: true });
});

const search = async () => {
  const result = await mcp.callTool({ name: 'atlas_search', arguments: { q: 'sam' } });
  return { isError: result.isError === true, content: result.content };
};

describe('dfai-mcp over stdio', () => {
  it('lists every tool', async () => {
    const { tools } = await mcp.listTools();
    expect(tools).toHaveLength(58);
  });

  it('picks up the connection file as it changes, without a restart', async () => {
    expect((await search()).content).toEqual([
      { type: 'text', text: expect.stringContaining('has not been turned on') },
    ]);

    await writeConnection('current', false);
    expect((await search()).content).toEqual([
      { type: 'text', text: expect.stringContaining('turned off') },
    ]);

    await writeConnection('stale');
    const refused = await search();
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).not.toContain('stale');

    await writeConnection('current');
    expect(await search()).toEqual({
      isError: false,
      content: [{ type: 'text', text: JSON.stringify({ hits: [] }, null, 2) }],
    });
    expect(atlas.requests.at(-1)).toMatchObject({
      method: 'GET',
      url: '/v1/search?q=sam',
      authorization: 'Bearer current',
    });
  });
});
