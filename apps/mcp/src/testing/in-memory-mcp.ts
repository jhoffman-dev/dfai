/**
 * The MCP server as a client sees it, over an in-memory transport, bound to
 * an `AtlasClient` that reaches `baseUrl` through `fetch`: a fake DFAI in a
 * unit test, or — through a `fetch` handing requests to the stub host — the
 * app's real router in an e2e test. Test support only.
 */

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { AtlasClient } from '../client.ts';
import { createAtlasServer } from '../server.ts';

export async function connectInMemoryMcp({
  baseUrl = 'http://127.0.0.1:1',
  fetch,
}: {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const connect = async () => ({ baseUrl, token: 'in-memory' });
  const client = new AtlasClient(fetch === undefined ? { connect } : { connect, fetch });
  await createAtlasServer(client).connect(serverSide);
  const mcp = new Client({ name: 'in-memory', version: '1.0.0' });
  await mcp.connect(clientSide);
  return mcp;
}
