import { afterEach } from 'vitest';
import { indexContract } from '@dfai/application/testing/index-contract';
import { sqliteIndexPort } from '@dfai/application/testing/sqlite';
import { remarkMarkdown } from '../markdown/markdown-port.ts';
import { WEB_INDEX } from './web-index-schema.ts';
import { inMemoryWebIndex, type InMemoryWebIndex } from './in-memory-web-index.ts';

/**
 * One suite, two indexes (#666): the desktop's stand-in, on the host's own
 * statements over node:sqlite, and the browser's, on SQLite's WebAssembly
 * build reached over a real message channel. Each query the app runs must
 * answer the same on both.
 */

indexContract("the desktop's index", {
  make: async () => sqliteIndexPort(),
  markdown: remarkMarkdown,
  // node:sqlite has no progress handler on the Node CI runs (22), so cannot stop one.
  stopsRunawayQueries: false,
});

let opened: InMemoryWebIndex[] = [];
afterEach(() => {
  for (const each of opened) each.close();
  opened = [];
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
