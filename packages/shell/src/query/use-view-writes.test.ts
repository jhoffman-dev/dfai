import { describe, expect, it } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import { fakeVaultFs, memoryVault } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { localToday } from '../today.ts';
import { writeNoteProperties } from './use-view-writes.ts';

/** P30-02: a note no pane holds is held to a task's rules as the view writes it. */
const PATH = createVaultPath('tasks/Call.md');
const TASK = '---\ntype: task\nstatus: next-action\n---\n\n# Call\n';
const noPane = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

function write(values: Readonly<Record<string, unknown>>) {
  const memory = memoryVault({ [PATH]: TASK });
  const done = writeNoteProperties({
    editors: noPane,
    fs: fakeVaultFs(memory.fs),
    markdown: remarkMarkdown,
    path: PATH,
    values,
  });
  return { done, files: memory.files };
}

describe('writeNoteProperties', () => {
  it('moves a task to Waiting with nobody to wait on, asking for no one (#202)', async () => {
    const { done, files } = write({ status: 'waiting' });
    await done;
    expect(files.get(PATH)).toBe('---\ntype: task\nstatus: waiting\n---\n\n# Call\n');
  });

  it('dates a task moved to Archive with today', async () => {
    const { done, files } = write({ status: 'archive' });
    await done;
    expect(files.get(PATH)).toBe(
      `---\ntype: task\nstatus: archive\ncompleted: ${localToday()}\n---\n\n# Call\n`,
    );
  });
});
