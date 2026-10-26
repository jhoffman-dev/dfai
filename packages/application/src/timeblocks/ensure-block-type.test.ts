/**
 * P31-01: a vault whose tasks follow GTD is given the Block type it lacks,
 * and a type the vault has is never touched.
 */
import { describe, expect, it } from 'vitest';
import type { MarkdownPort } from '../notes/ports.ts';
import { memoryVault } from '../testing/fake-git.ts';
import { fakeVaultFs } from '../testing/fake-ports.ts';
import { jsonMarkdown, jsonNote } from '../testing/json-markdown.ts';
import { loadObjectTypes } from '../types/load-types.ts';
import { ensureBlockType } from './ensure-block-type.ts';

const GTD_STATUSES = [
  'inbox',
  'backlog',
  'next-action',
  'in-progress',
  'waiting',
  'someday',
  'longterm',
  'archive',
];
const TASK = jsonNote({
  name: 'task',
  label: 'Task',
  properties: { status: { kind: 'select', options: GTD_STATUSES, done: 'archive' } },
});
const OWN_TASK = jsonNote({
  name: 'task',
  label: 'Task',
  properties: { status: { kind: 'select', options: ['backlog', 'done'], done: 'done' } },
});
const OWN_BLOCK = jsonNote({ name: 'block', label: 'Focus block', properties: { when: 'date' } });

/** JSON frontmatter, read and written, so the type file written can be read back whole. */
function jsonFrontmatter(): MarkdownPort {
  const markdown = jsonMarkdown();
  return {
    ...markdown,
    updateFrontmatter: (frontmatter, changes) => {
      const next = { ...markdown.frontmatterProperties(frontmatter) };
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === undefined) delete next[key];
        else next[key] = value;
      }
      return `---\n${JSON.stringify(next)}\n---\n`;
    },
  };
}

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
  return { fs, files: memory.files, markdown: jsonFrontmatter() };
}

describe('ensureBlockType', () => {
  it('writes the Block type into a vault whose tasks follow GTD', async () => {
    const v = vault({ '.atlas/types/task.md': TASK });

    const ensured = await ensureBlockType(v);

    expect(ensured).toEqual({ created: ['.atlas/types/block.md'], failed: [] });
    expect(v.files.get('.atlas/types/task.md')).toBe(TASK);
    const block = (await loadObjectTypes(v)).find((type) => type.name === 'block');
    expect(block?.properties.map((property) => property.key)).toEqual([
      'start',
      'end',
      'tasks',
      'gcal_event_id',
      'gcal_etag',
      'gcal_calendar',
      'gcal_missing',
      'gcal_synced_title',
      'gcal_synced_start',
      'gcal_synced_end',
      'gcal_pending',
    ]);
  });

  it('writes nothing into a vault with no tasks, or tasks on statuses of its own', async () => {
    const empty = vault({});
    expect(await ensureBlockType(empty)).toEqual({ created: [], failed: [] });
    expect([...empty.files.keys()]).toEqual([]);
    const own = vault({ '.atlas/types/task.md': OWN_TASK });
    expect(await ensureBlockType(own)).toEqual({ created: [], failed: [] });
    expect([...own.files.keys()]).toEqual(['.atlas/types/task.md']);
  });

  it('leaves a Block type the vault has as it is', async () => {
    const v = vault({ '.atlas/types/task.md': TASK, '.atlas/types/block.md': OWN_BLOCK });
    expect(await ensureBlockType(v)).toEqual({ created: [], failed: [] });
    expect(v.files.get('.atlas/types/block.md')).toBe(OWN_BLOCK);
  });

  it('says why when the type file cannot be written', async () => {
    const v = vault({ '.atlas/types/task.md': TASK });
    const refusing = {
      ...v,
      fs: { ...v.fs, createNote: async () => Promise.reject(new Error('the disk is full')) },
    };

    expect(await ensureBlockType(refusing)).toEqual({
      created: [],
      failed: [{ name: 'Block', reason: 'the disk is full' }],
    });
  });
});
