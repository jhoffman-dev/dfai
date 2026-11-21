/**
 * A task's priority through the property writes (#913). The one write behind
 * every property edit writes a `priority` as it is given, as it did before
 * DFAI had one: a vault may keep its own. A caller that holds the vault's
 * types holds the change to 1 to 4 first (`withTaskPriority`), where the
 * vault's Task type keeps priority as a number or not at all.
 */
import { describe, expect, it } from 'vitest';
import { parseObjectType } from '@dfai/domain';
import { memoryVault } from '../testing/fake-git.ts';
import { fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { TaskRuleRefusedError, withTaskPriority } from '../gtd/task-rules.ts';
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

  it('writes a value of the vault’s own as given: it is not told the vault ranks its tasks', async () => {
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

const NUMBER_TYPE = parseObjectType({ name: 'task', properties: { priority: 'number' } });
const OWN_TYPE = parseObjectType({
  name: 'task',
  properties: { priority: { kind: 'select', options: ['High', 'Medium', 'Low'] } },
});
const ON_A_TASK: Readonly<Record<string, unknown>> = { type: 'task', status: 'next-action' };

describe('withTaskPriority', () => {
  const held = (changes: Record<string, unknown>, types = [NUMBER_TYPE], before = ON_A_TASK) =>
    withTaskPriority({ types, before, changes });

  it('accepts 1 to 4, writes "2" as 2 and a blank as none, where the vault ranks its tasks', () => {
    for (const priority of [1, 2, 3, 4]) expect(held({ priority })).toEqual({ priority });
    expect(held({ priority: '2' })).toEqual({ priority: 2 });
    expect(held({ priority: '' })).toEqual({ priority: null });
    expect(held({ priority: 3 }, [])).toEqual({ priority: 3 });
  });

  it('refuses 0, 5, 2.5 and "high"', () => {
    for (const priority of [0, 5, 2.5, 'high']) {
      expect(() => held({ priority })).toThrow(TaskRuleRefusedError);
    }
  });

  it('stands aside for a Task type that keeps a priority of its own, a note that is not a task, and a change that names none', () => {
    expect(held({ priority: 'Medium' }, [OWN_TYPE])).toEqual({ priority: 'Medium' });
    expect(held({ priority: 7 }, [NUMBER_TYPE], { type: 'goal' })).toEqual({ priority: 7 });
    expect(held({ status: 'waiting' }, [NUMBER_TYPE], { ...ON_A_TASK, priority: 'x' })).toEqual({
      status: 'waiting',
    });
  });
});
