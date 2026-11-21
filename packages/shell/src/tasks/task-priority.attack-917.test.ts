/**
 * Adversarial pass on #913 (PR #917): a vault that already writes `priority`
 * its own way. A new task made from the vault's own template must be
 * made, as it was before priorities shipped.
 */
import { describe, expect, it } from 'vitest';
import { createVaultPath, type ObjectType, type VaultEntry } from '@dfai/domain';
import {
  createNote,
  createNoteOfType,
  fakeVaultFs,
  memoryVault,
  setNoteProperties,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';

/** `priority` lines people and other tools already write, none of them 1 to 4 as a number. */
const OWN_PRIORITIES: readonly string[] = [
  'priority: high',
  'priority: "A"',
  'priority: 7',
  'priority: [1, 2]',
  'priority: "2"',
];

const TASK_TYPE: ObjectType = { name: 'task', label: 'Task', properties: [] };
const templateText = (line: string) => `---\ntype: task\nstatus: inbox\n${line}\n---\n\n## Notes\n`;

function templateVault(text: string) {
  const created: { path: string; contents: string }[] = [];
  const template: VaultEntry = {
    kind: 'file',
    name: 'Task.md',
    path: createVaultPath('.atlas/templates/Task.md'),
  };
  const fs = fakeVaultFs({
    listDirectory: async (path) => (path === '.atlas/templates' ? [template] : []),
    readTextFile: async () => ({ text, modified: 1 }),
    createNote: async (args) => {
      created.push(args);
      return 0;
    },
  });
  return { fs, created };
}

describe('a vault’s own priority values, after #913', () => {
  for (const line of OWN_PRIORITIES) {
    it(`makes a new task from a template holding \`${line}\`, that line as written`, async () => {
      const vault = templateVault(templateText(line));
      await createNoteOfType({
        fs: vault.fs,
        markdown: remarkMarkdown,
        type: TASK_TYPE,
        notePaths: [],
        today: '2026-11-18',
      });
      expect(vault.created).toHaveLength(1);
      expect(vault.created[0]?.contents.split('\n')).toContain(line);
    });

    it(`makes a pasted task note holding \`${line}\` byte for byte`, async () => {
      const vault = templateVault('');
      const contents = templateText(line);
      await createNote({
        fs: vault.fs,
        markdown: remarkMarkdown,
        today: '2026-11-18',
        name: 'Call Mara Quill',
        beside: null,
        notePaths: [],
        contents,
      });
      expect(vault.created[0]?.contents).toBe(contents);
    });
  }

  it('writes a pick from the vault’s own Task type, whose `priority` is a select of High, Medium and Low', async () => {
    const path = 'Tasks/Pay Larkspur Payroll.md';
    const before = '---\ntype: task\nstatus: next-action\npriority: High\n---\n\n# Pay\n';
    const memory = memoryVault({ [path]: before });
    await setNoteProperties({
      fs: fakeVaultFs(memory.fs),
      markdown: remarkMarkdown,
      path,
      values: { priority: 'Medium' },
      today: '2026-11-18',
    });
    expect(memory.files.get(path)).toBe(before.replace('priority: High', 'priority: Medium'));
  });
});
