/**
 * A task's priority through the one property write (#913): every caller — the
 * properties panel, a table cell, Clarify, the API's property route — reaches
 * the task rules here, so what is asserted is what the file says afterwards,
 * and that a refusal writes nothing.
 */
import { describe, expect, it } from 'vitest';
import { memoryVault } from '../testing/fake-git.ts';
import { fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { TaskRuleRefusedError } from '../gtd/task-rules.ts';
import { setNoteProperties } from './set-property.ts';

const PATH = 'Tasks/Call the bank.md';
const TASK = '---\ntype: task\nstatus: next-action\n---\n\n# Call the bank\n';
const PLAIN = '---\nstatus: draft\n---\n\n# Notes\n';

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

  it('writes a digit sent as text as the number', async () => {
    const v = vault();
    await v.write({ priority: '3' });
    expect(v.text()).toContain('\npriority: 3\n');
  });

  it('refuses 0, 5, 2.5 and "high", and writes nothing', async () => {
    for (const priority of [0, 5, 2.5, 'high']) {
      const v = vault();
      await expect(v.write({ priority })).rejects.toBeInstanceOf(TaskRuleRefusedError);
      expect(v.text()).toBe(TASK);
    }
  });

  it('refuses the whole change, the other keys in it as well', async () => {
    const v = vault();
    await expect(v.write({ status: 'waiting', priority: 7 })).rejects.toBeInstanceOf(
      TaskRuleRefusedError,
    );
    expect(v.text()).toBe(TASK);
  });

  it('takes the key out when cleared, leaving the note as it was before it had one', async () => {
    const v = vault();
    await v.write({ priority: 2 });
    await v.write({ priority: null });
    expect(v.text()).toBe(TASK);
  });

  it('takes it out for a blank too, as an emptied field sends', async () => {
    const v = vault();
    await v.write({ priority: 1 });
    await v.write({ priority: '' });
    expect(v.text()).toBe(TASK);
  });

  it('leaves a note that is not a task to say what it likes', async () => {
    const v = vault(PLAIN);
    await v.write({ priority: 'high' });
    expect(v.text()).toContain('\npriority: high\n');
  });
});
