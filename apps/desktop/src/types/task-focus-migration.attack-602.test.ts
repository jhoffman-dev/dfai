/**
 * Attack on PR #602 (#108): a vault's own Task type gains `focus` on
 * opening through the real markdown adapter, adding only lines — its
 * comments, quoting and CRLF line ends kept byte for byte.
 */
import { describe, expect, it } from 'vitest';
import { ensureBuiltInTypes, fakeVaultFs, memoryVault } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';

const PATH = '.atlas/types/task.md';

function vault(files: Record<string, string>) {
  const memory = memoryVault(files);
  const fs = fakeVaultFs({
    ...memory.fs,
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const text = memory.files.get(path);
        return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
      }),
  });
  return { fs, files: memory.files, markdown: remarkMarkdown };
}

const OWN_TASK = [
  '---',
  '# James keeps his own Task type',
  'name: task',
  "label: 'Task'",
  'properties:',
  '  status: select   # GTD statuses',
  '  estimate:',
  '    kind: text',
  '    label: "Size"',
  '---',
  '',
  '# Task',
  '',
].join('\n');

describe('Task gains focus on opening (#108)', () => {
  it('adds only lines to a Task type with comments and quoting', async () => {
    const v = vault({ [PATH]: OWN_TASK });

    await ensureBuiltInTypes(v);

    const after = v.files.get(PATH) ?? '';
    expect(after).toContain('focus');
    const kept = OWN_TASK.split('\n');
    const lines = after.split('\n');
    expect(lines.filter((line) => kept.includes(line))).toEqual(kept);
  });

  it('keeps a CRLF Task type CRLF throughout', async () => {
    const crlf = OWN_TASK.replaceAll('\n', '\r\n');
    const v = vault({ [PATH]: crlf });

    await ensureBuiltInTypes(v);

    const after = v.files.get(PATH) ?? '';
    expect(after).toContain('focus');
    expect(after.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('a second opening adds nothing more', async () => {
    const v = vault({ [PATH]: OWN_TASK });

    await ensureBuiltInTypes(v);
    const once = v.files.get(PATH);
    await ensureBuiltInTypes(v);

    expect(v.files.get(PATH)).toBe(once);
  });
});
