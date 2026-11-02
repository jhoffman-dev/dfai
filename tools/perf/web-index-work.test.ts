import { describe, expect, it } from 'vitest';
import { fixtureVault } from './fixture-vault.ts';
import { runWebIndexActions } from './web-index-work.ts';

/**
 * The browser index's budgeted actions (#666), as `budgets.spec.ts` counts
 * them: the second open reads only the notes that changed, and a run counts
 * the same work every time, so the budgets can hold it.
 */
/** Indexing 2,000 notes in WebAssembly, under coverage on a loaded machine, takes a while. */
const LONG_MS = 120_000;

describe('the browser index work the budgets count', () => {
  it(
    'reads every note the first time, only the changed ones the second, and none to query',
    async () => {
      const { work } = await runWebIndexActions();
      const reads = (action: Parameters<typeof work.get>[0]) =>
        work.get(action)?.calls['notes_read'];
      // Every note in the vault, its types' notes too: what a refresh lists.
      const notes = fixtureVault().filter((file) => file.path.endsWith('.md')).length;
      expect(notes).toBeGreaterThanOrEqual(2000);
      expect(reads('Open a 2,000-note vault in the browser')).toBe(notes);
      expect(reads('Open it again in the browser, 3 notes changed')).toBe(3);
      expect(reads('Read Today and the Inbox in the browser')).toBe(0);
      expect(work.get('Read Today and the Inbox in the browser')?.calls['index_query']).toBe(4);
    },
    LONG_MS,
  );

  it(
    'counts the same work on every run',
    async () => {
      const [first, second] = [await runWebIndexActions(), await runWebIndexActions()];
      expect([...second.work]).toEqual([...first.work]);
    },
    LONG_MS,
  );
});
