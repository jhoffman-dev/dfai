/**
 * Review of PR #917 (#913): making a note never refuses or rewrites a
 * `priority` it is handed. A vault that writes `priority: high`, `"A"`, `7`,
 * `[1, 2]` or `"2"` in a template, a capture or a pasted note gets the note
 * byte for byte as it was before DFAI had a priority. Through the app's own
 * creation paths and the real markdown.
 */
import { describe, expect, it } from 'vitest';
import { createVaultPath, parseObjectType } from '@dfai/domain';
import {
  captureToInbox,
  fakeVaultFs,
  memoryVault,
  newNoteTaskRules,
  quickAddNote,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';

const OWN_PRIORITIES: readonly string[] = [
  'priority: high',
  'priority: "A"',
  'priority: 7',
  'priority: [1, 2]',
  'priority: "2"',
];

const TODAY = '2026-11-21';
const taskText = (line: string) => `---\ntype: task\nstatus: inbox\n${line}\n---\n\n## Notes\n`;
const TASK_TYPE = parseObjectType({ name: 'task', properties: { status: 'text' } });

describe('a priority a new note is handed (#917 review, item 1)', () => {
  for (const line of OWN_PRIORITIES) {
    it(`is judged by no rule as a new note's text: \`${line}\``, () => {
      const contents = taskText(line);
      expect(newNoteTaskRules({ markdown: remarkMarkdown, contents, today: TODAY })).toBe(contents);
    });

    it(`is captured to the Inbox from the template as written: \`${line}\``, async () => {
      const memory = memoryVault({});
      const path = await captureToInbox({
        fs: fakeVaultFs(memory.fs),
        markdown: remarkMarkdown,
        today: TODAY,
        name: 'Call Mara Quill',
        notePaths: [],
        contents: taskText(line),
      });
      expect(memory.files.get(path)).toBe(taskText(line));
    });

    it(`is quick-added from the template as written: \`${line}\``, async () => {
      const memory = memoryVault({});
      const path = await quickAddNote({
        fs: fakeVaultFs(memory.fs),
        markdown: remarkMarkdown,
        type: TASK_TYPE,
        name: 'Pay Larkspur Payroll',
        values: {},
        template: taskText(line),
        beside: createVaultPath('Notes.md'),
        notePaths: [],
        today: TODAY,
      });
      expect(memory.files.get(path)?.split('\n')).toContain(line);
    });
  }
});
