import { describe, expect, it } from 'vitest';
import { createVaultPath, deleteThroughLinkRefusal, type VaultPath } from '@dfai/domain';
import { refreshIndex } from '../index/refresh-index.ts';
import { apiFixture, bodyOf, codeOf } from '../testing/api-fixture.ts';
import {
  jsonFrontmatterMarkdown as markdown,
  jsonFrontmatterNote as note,
} from '../testing/guarded-vault.ts';
import { sqliteIndexPort } from '../testing/sqlite-index.ts';
import { VaultAccessError } from '../vault/ports.ts';

/* #464 through the local API: the possible duplicate people, and merging them. */

const KEPT = 'People/Mara Quill.md';
const SHORT = 'Mara.md';

const FILES = {
  [KEPT]: note(
    { type: 'person', email: 'mara.quill@larkspur.example.com', role: 'Payroll lead' },
    'Leads payroll.\n',
  ),
  [SHORT]: note(
    { type: 'person', email: 'mara@larkspur.example.com', role: 'Analyst' },
    'Met at the kickoff.\n',
  ),
  'Tobias Fenn.md': note({ type: 'person' }, ''),
  'People/Tobias Fenn.md': note({ type: 'person' }, ''),
  'Kickoff.md': note({ attendees: ['[[Mara]]'] }, 'With [[Mara|M]] of Larkspur Payroll.\n'),
  '.atlas/templates/Brief.md': 'Ask [[Mara]].\n',
  'Plan.md': 'A plan.\n',
};

async function vault(
  files: Record<string, string> = FILES,
  { dirty = [] as string[] }: { dirty?: string[] } = {},
) {
  const api = apiFixture({ files, markdown });
  const index = sqliteIndexPort();
  await refreshIndex({ fs: api.fs, index, markdown });
  const trashed: string[] = [];
  const reloaded: string[] = [];
  const flushed: (readonly VaultPath[])[] = [];
  api.deps = {
    ...api.deps,
    index,
    fs: {
      ...api.deps.fs,
      // The app's Trash: the file goes from the vault, recoverable from the system's Trash.
      trashEntry: async ({ path }) => {
        api.files.delete(path);
        trashed.push(path);
      },
    },
    movingNotes: {
      ...api.deps.movingNotes,
      state: (path) => (dirty.includes(path) ? 'dirty' : 'closed'),
      flush: async (paths) => {
        flushed.push(paths);
      },
      reload: (path) => reloaded.push(path),
    },
  };
  return { api, trashed, flushed };
}

const merge = (api: ReturnType<typeof apiFixture>, body: unknown) =>
  api.send({ method: 'POST', path: '/v1/people/merge', body });

/** The version a preview of merging SHORT into KEPT answers with. */
async function versionOf(api: ReturnType<typeof apiFixture>): Promise<string> {
  const shown = bodyOf(await merge(api, { keep: KEPT, merge: [SHORT] }))['merge'] as {
    version: string;
  };
  return shown.version;
}

describe('GET /v1/people/duplicates', () => {
  it('answers each pair who may be one person, with why, surest first', async () => {
    const { api } = await vault();
    const response = await api.send({ method: 'GET', path: '/v1/people/duplicates' });
    expect(response.status).toBe(200);
    expect(bodyOf(response)['pairs']).toEqual([
      {
        left: { path: 'People/Tobias Fenn.md', name: 'Tobias Fenn' },
        right: { path: 'Tobias Fenn.md', name: 'Tobias Fenn' },
        reasons: [{ kind: 'same-name' }],
      },
      {
        left: { path: SHORT, name: 'Mara' },
        right: { path: KEPT, name: 'Mara Quill' },
        reasons: [
          {
            kind: 'similar-email',
            left: 'mara@larkspur.example.com',
            right: 'mara.quill@larkspur.example.com',
            local: 'first-name',
            sameDomain: true,
          },
        ],
      },
    ]);
  });
});

describe('POST /v1/people/merge', () => {
  it('previews by default: counts and conflicts, with nothing written', async () => {
    const { api, trashed } = await vault();
    const response = await merge(api, { keep: KEPT, merge: [SHORT] });
    expect(response.status).toBe(200);
    expect(bodyOf(response)['merge']).toEqual({
      keep: KEPT,
      merge: [SHORT],
      refusal: null,
      notes: [
        { path: 'Kickoff.md', links: 2 },
        { path: '.atlas/templates/Brief.md', links: 1 },
        { path: KEPT, links: 0 },
      ],
      links: 3,
      conflicts: [{ key: 'role', kept: 'Payroll lead', other: 'Analyst', from: SHORT }],
      aliasesAdded: ['Mara'],
      emailsAdded: ['mara@larkspur.example.com'],
      appended: [{ from: SHORT, heading: '## Merged from Mara' }],
      version: expect.stringMatching(/^(?:[0-9a-f]{8})+$/u),
    });
    expect(bodyOf(response)['report']).toBeUndefined();
    expect(api.writes).toEqual([]);
    expect(api.activity.reports).toEqual([]);
    expect(trashed).toEqual([]);
  });

  it('merges with confirm: links re-pointed, the kept note merged, the merged person trashed', async () => {
    const { api, trashed } = await vault();
    const version = await versionOf(api);
    const response = await merge(api, { keep: KEPT, merge: [SHORT], confirm: true, version });
    expect(response.status).toBe(200);
    expect(bodyOf(response)['report']).toEqual({
      written: ['Kickoff.md', '.atlas/templates/Brief.md', KEPT],
      notWritten: [],
      trashed: [SHORT],
      notTrashed: [],
      failures: [],
      links: 3,
    });
    expect(api.files.get('Kickoff.md')?.text).toBe(
      note({ attendees: ['[[Mara Quill]]'] }, 'With [[Mara Quill|M]] of Larkspur Payroll.\n'),
    );
    expect(api.files.get(KEPT)?.text).toContain('## Merged from Mara\n\nMet at the kickoff.\n');
    // A template is the person's own words: it is rewritten as the app rewrites it.
    expect(api.files.get('.atlas/templates/Brief.md')?.text).toBe('Ask [[Mara Quill]].\n');
    expect(trashed).toEqual([SHORT]);
    // An answer that wrote is said in the Activity log; a preview is not.
    expect(api.activity.reports.length).toBeGreaterThan(0);
  });

  it('reports a merged person the host will not trash through a link, in the domain’s words (#685)', async () => {
    const { api } = await vault();
    const refusal = deleteThroughLinkRefusal(createVaultPath('Shared'));
    api.deps = {
      ...api.deps,
      fs: {
        ...api.deps.fs,
        trashEntry: async () => {
          throw new VaultAccessError(refusal);
        },
      },
    };
    const version = await versionOf(api);
    const response = await merge(api, { keep: KEPT, merge: [SHORT], confirm: true, version });

    expect(response.status).toBe(200);
    const report = bodyOf(response)['report'] as Record<string, unknown>;
    expect(report['trashed']).toEqual([]);
    expect(report['notTrashed']).toEqual([SHORT]);
    expect(report['failures']).toEqual([{ path: SHORT, step: 'trash', reason: refusal }]);
    expect(api.files.has(SHORT)).toBe(true);
  });

  it('saves typing in the app first, and is a conflict while some cannot be saved', async () => {
    const { api, flushed } = await vault(FILES, { dirty: ['Kickoff.md'] });
    const preview = bodyOf(await merge(api, { keep: KEPT, merge: [SHORT] }))['merge'] as {
      refusal: string;
    };
    expect(preview.refusal).toBe('Kickoff.md has unsaved changes. Save them first.');
    expect(flushed).toEqual([['Kickoff.md']]);
    const confirmed = await merge(api, { keep: KEPT, merge: [SHORT], confirm: true });
    expect(codeOf(confirmed)).toBe('conflict');
    expect(api.writes).toEqual([]);
  });

  it('saves typing in every pane before it looks for links, and refuses while a save is refused', async () => {
    const { api, flushed } = await vault();
    api.deps = {
      ...api.deps,
      movingNotes: {
        ...api.deps.movingNotes,
        state: (path) => (path === 'Notes.md' ? 'dirty' : 'closed'),
        dirtyPaths: () => [createVaultPath('Notes.md')],
      },
    };
    const preview = bodyOf(await merge(api, { keep: KEPT, merge: [SHORT] }))['merge'] as {
      refusal: string;
    };
    expect(flushed).toEqual([['Notes.md']]);
    expect(preview.refusal).toBe(
      "Notes.md has typing that couldn't be saved — it may link to Mara. Save it, then merge.",
    );
  });

  it('is a conflict when the app’s index cannot catch up with the vault', async () => {
    const { api } = await vault();
    const asked: (readonly string[])[] = [];
    api.deps = {
      ...api.deps,
      indexRefresh: async (recheck) => {
        asked.push(recheck);
        return false;
      },
    };
    const response = await merge(api, { keep: KEPT, merge: [SHORT] });
    expect(codeOf(response)).toBe('conflict');
    expect(asked).toEqual([[]]);
    expect(api.writes).toEqual([]);
  });

  it('refuses a note that is not a person, as invalid with confirm and as a refusal without', async () => {
    const { api } = await vault();
    const preview = bodyOf(await merge(api, { keep: KEPT, merge: ['Plan.md'] }))['merge'];
    expect(preview).toMatchObject({ refusal: 'Plan is not a person.', notes: [], links: 0 });
    const confirmed = await merge(api, { keep: KEPT, merge: ['Plan.md'], confirm: true });
    expect(codeOf(confirmed)).toBe('invalid');
    expect(api.writes).toEqual([]);
  });

  it('is a conflict, with nothing written, when a confirm carries no version or another one', async () => {
    const { api, trashed } = await vault();
    for (const version of [undefined, 'not-this-one']) {
      const confirmed = await merge(api, { keep: KEPT, merge: [SHORT], confirm: true, version });
      expect(codeOf(confirmed)).toBe('conflict');
    }
    expect(api.writes).toEqual([]);
    expect(trashed).toEqual([]);
  });

  it('is a conflict, with nothing written, when a note changes between the preview and the writes', async () => {
    const { api } = await vault();
    const version = await versionOf(api);
    const { readNotes } = api.deps.fs;
    let reads = 0;
    api.deps = {
      ...api.deps,
      fs: {
        ...api.deps.fs,
        // Another program writes Kickoff.md after the preview read it, before the merge writes.
        readNotes: async (paths) => {
          if (paths.includes('Kickoff.md') && ++reads === 2) {
            const kickoff = api.files.get('Kickoff.md')!;
            api.files.set('Kickoff.md', { text: `${kickoff.text}More.\n`, modified: 999 });
          }
          return readNotes(paths);
        },
      },
    };
    const response = await merge(api, { keep: KEPT, merge: [SHORT], confirm: true, version });
    expect(response.status).toBe(409);
    expect(codeOf(response)).toBe('conflict');
    expect(api.writes).toEqual([]);
  });

  it('refuses a body that does not name the people', async () => {
    const { api } = await vault();
    expect(codeOf(await merge(api, { merge: [SHORT] }))).toBe('invalid');
    expect(codeOf(await merge(api, { keep: KEPT, merge: [] }))).toBe('invalid');
    expect(codeOf(await merge(api, { keep: KEPT, merge: [3] }))).toBe('invalid');
    expect(codeOf(await merge(api, { keep: KEPT, merge: ['notes.txt'] }))).toBe('invalid');
    expect(codeOf(await merge(api, { keep: KEPT, merge: ['.atlas/settings.md'] }))).toBe('invalid');
    expect(codeOf(await merge(api, { keep: KEPT, merge: ['Nobody.md'] }))).toBe('not_found');
    expect(codeOf(await merge(api, { keep: KEPT, merge: [SHORT], confirm: 'yes' }))).toBe(
      'invalid',
    );
    expect(api.writes).toEqual([]);
  });
});
