/**
 * The MCP server as a client sees it, over an in-memory transport, its
 * requests sent through the `fetch` given: so an e2e test can hand them to the
 * stub host and reach the app's real router. Test support only.
 */

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { AtlasClient } from '../client.ts';
import { createAtlasServer } from '../server.ts';

export async function connectInMemoryMcp(fetch: typeof globalThis.fetch): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const connect = async () => ({ baseUrl: 'http://127.0.0.1:1', token: 'in-memory' });
  await createAtlasServer(new AtlasClient({ connect, fetch })).connect(serverSide);
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}
