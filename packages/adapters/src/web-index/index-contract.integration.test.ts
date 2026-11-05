import { afterEach, expect } from 'vitest';
import { indexContract } from '@dfai/application/testing/index-contract';
import { sqliteIndexPort } from '@dfai/application/testing/sqlite';
import { remarkMarkdown } from '../markdown/markdown-port.ts';
import { WEB_INDEX } from './web-index-schema.ts';
import { inMemoryWebIndex, sqliteWasm, type InMemoryWebIndex } from './in-memory-web-index.ts';
import { indexHostOver, serveIndexHost, type IndexEndpoint } from './index-channel.ts';
import { startIndexHost } from './start-index-host.ts';
import { webIndexPort } from './web-index-port.ts';

/**
 * One suite, two indexes (#666): the desktop's stand-in, on the host's own
 * statements over node:sqlite, and the browser's, on SQLite's WebAssembly
 * build reached over a real message channel. Each query the app runs must
 * answer the same on both — and on the browser's index kept in memory, where
 * the browser refuses it OPFS (#761).
 */

indexContract("the desktop's index", {
  make: async () => sqliteIndexPort(),
  markdown: remarkMarkdown,
  // node:sqlite has no progress handler on the Node CI runs (22), so cannot stop one.
  stopsRunawayQueries: false,
});

let opened: InMemoryWebIndex[] = [];
let channels: MessageChannel[] = [];
afterEach(() => {
  for (const each of opened) each.close();
  opened = [];
  for (const channel of channels) [channel.port1, channel.port2].forEach((port) => port.close());
  channels = [];
});

indexContract("the browser's index (SQLite WebAssembly, over its channel)", {
  make: async () => {
    const web = await inMemoryWebIndex({
      shape: WEB_INDEX,
      openVault: () => 'github:example/garden',
    });
    opened.push(web);
    await web.index.open();
    return web.index;
  },
  markdown: remarkMarkdown,
});

indexContract("the browser's index in memory, where OPFS is refused (#761)", {
  make: async () => {
    const sqlite3 = await sqliteWasm();
    const channel = new MessageChannel();
    channels.push(channel);
    serveIndexHost(channel.port1 as IndexEndpoint, () =>
      startIndexHost({
        sqlite3,
        installPool: () =>
          Promise.reject(new DOMException('The request is not allowed.', 'SecurityError')),
        shape: WEB_INDEX,
        clock: { now: () => 0 },
      }),
    );
    channel.port1.start();
    channel.port2.start();
    const host = indexHostOver(channel.port2 as IndexEndpoint);
    const index = webIndexPort({ host: () => host, openVault: () => 'github:example/garden' });
    expect(await index.open()).toEqual({ fresh: true, kept: false });
    return index;
  },
  markdown: remarkMarkdown,
});
