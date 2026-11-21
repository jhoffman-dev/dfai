/**
 * A task's priority through the one write behind every property edit (#913):
 * a soft field, written as it is given, as before DFAI had one, since a vault
 * or an outside tool may keep its own values there.
 */
import { describe, expect, it } from 'vitest';
import { memoryVault } from '../testing/fake-git.ts';
import { fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { setNoteProperties } from './set-property.ts';

const PATH = 'Tasks/Call the bank.md';
const TASK = '---\ntype: task\nstatus: next-action\n---\n\n# Call the bank\n';

function vault(text = TASK) {
  const memory = memoryVault({ [PATH]: text });
  const write = (values: Record<string, unknown>) =>
    setNoteProperties({
      fs: fakeVaultFs(memory.fs),
      markdown: fakeMarkdown(),
      path: PATH,
      values,
      today: '2026-11-18',
    });
  return { write, text: () => memory.files.get(PATH) };
}

describe('setNoteProperties and a task’s priority', () => {
  it('writes each of 1 to 4', async () => {
    for (const priority of [1, 2, 3, 4]) {
      const v = vault();
      await v.write({ priority });
      expect(v.text()).toBe(
        `---\ntype: task\nstatus: next-action\npriority: ${priority}\n---\n\n# Call the bank\n`,
      );
    }
  });

  it('writes a value of the vault’s own as given, refusing and rewriting nothing', async () => {
    for (const priority of ['high', 7, '2']) {
      const v = vault();
      await v.write({ priority });
      expect(v.text()).toContain(`\npriority: ${String(priority)}\n`);
    }
  });

  it('takes the key out when cleared, leaving the note as it was before it had one', async () => {
    const v = vault();
    await v.write({ priority: 2 });
    await v.write({ priority: null });
    expect(v.text()).toBe(TASK);
  });
});
