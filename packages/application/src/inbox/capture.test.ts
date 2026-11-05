import { describe, expect, it } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import { memoryVault } from '../testing/fake-git.ts';
import { fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { capturedTaskContents, captureToInbox } from './capture.ts';

function vault(files: Record<string, string>) {
  const memory = memoryVault(files);
  return { fs: fakeVaultFs(memory.fs), files: memory.files };
}

describe('captureToInbox', () => {
  it('lands the captured note in the Inbox, making the folder when the vault has none', async () => {
    const v = vault({ 'Projects/DFAI.md': 'x\n' });
    const path = await captureToInbox({
      markdown: fakeMarkdown(),
      today: '2026-10-08',
      fs: v.fs,
      name: 'Renew the passport',
      notePaths: [createVaultPath('Projects/DFAI.md')],
      contents: '---\ntype: task\n---\n',
    });
    expect(path).toBe('Inbox/Renew the passport.md');
    expect(v.files.get('Inbox/Renew the passport.md')).toBe('---\ntype: task\n---\n');
  });

  it('names a pasted paragraph by its first line, and cuts a line too long for a disk (#672)', async () => {
    const v = vault({});
    const path = await captureToInbox({
      markdown: fakeMarkdown(),
      today: '2026-10-08',
      fs: v.fs,
      name: 'Call Tobias Fenn\nabout the seed order\nand the fence',
      notePaths: [],
    });
    expect(path).toBe('Inbox/Call Tobias Fenn.md');
    const long = await captureToInbox({
      markdown: fakeMarkdown(),
      today: '2026-10-08',
      fs: v.fs,
      name: 'Seed '.repeat(80).trim(),
      notePaths: [createVaultPath(path)],
    });
    expect(new TextEncoder().encode(long.slice('Inbox/'.length)).length).toBeLessThanOrEqual(255);
    expect(long.startsWith('Inbox/Seed Seed ')).toBe(true);
  });

  it('uses the Inbox as the disk spells it, and numbers a name already waiting there', async () => {
    const v = vault({ 'inbox/Call.md': 'first\n' });
    const path = await captureToInbox({
      markdown: fakeMarkdown(),
      today: '2026-10-08',
      fs: v.fs,
      name: 'Call',
      notePaths: [createVaultPath('inbox/Call.md')],
    });
    expect(path).toBe('inbox/Call 2.md');
  });
});

describe('capturedTaskContents', () => {
  const GTD_TASK =
    '---\nname: task\nproperties:\n  status:\n    kind: select\n    options: [inbox, backlog, archive]\n    done: archive\n---\n';
  const OLD_TASK =
    '---\nname: task\nproperties:\n  status:\n    kind: select\n    options: [backlog, done]\n    done: done\n---\n';
  const TEMPLATE = '---\ntype: task\nstatus: backlog\n---\n\n# \n';

  function typed(typeFile: string) {
    const memory = memoryVault({ '.atlas/types/task.md': typeFile });
    const fs = fakeVaultFs({
      ...memory.fs,
      readNotes: async (paths) =>
        paths.map((path) => ({ path, text: memory.files.get(path) ?? '', modified: 1, size: 1 })),
    });
    return { fs, markdown: yamlish() };
  }

  /** Enough YAML for a type file's nested status, and `key: value` lines for a note. */
  function yamlish() {
    const markdown = fakeMarkdown();
    return {
      ...markdown,
      frontmatterProperties: (frontmatter: string | null) =>
        frontmatter?.includes('name: task')
          ? {
              name: 'task',
              properties: {
                status: {
                  kind: 'select',
                  options: /options: \[(.*)\]/.exec(frontmatter)?.[1]?.split(', ') ?? [],
                  done: /done: (\w+)/.exec(frontmatter)?.[1],
                },
              },
            }
          : markdown.frontmatterProperties(frontmatter),
    };
  }

  it('starts a captured task in the Inbox when the Task type has it, keeping the body', async () => {
    const contents = await capturedTaskContents({ ...typed(GTD_TASK), contents: TEMPLATE });
    expect(contents).toBe('---\ntype: task\nstatus: inbox\n---\n\n# \n');
  });

  it('keeps the template’s status in a vault still on statuses of its own', async () => {
    expect(await capturedTaskContents({ ...typed(OLD_TASK), contents: TEMPLATE })).toBe(TEMPLATE);
  });

  it('leaves text that is not a task as it is', async () => {
    const note = '---\ntype: meeting\nstatus: backlog\n---\n';
    expect(await capturedTaskContents({ ...typed(GTD_TASK), contents: note })).toBe(note);
    expect(await capturedTaskContents({ ...typed(GTD_TASK), contents: '# Plain\n' })).toBe(
      '# Plain\n',
    );
  });
});
