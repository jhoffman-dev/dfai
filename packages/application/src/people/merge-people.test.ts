import { describe, expect, it } from 'vitest';
import { createVaultPath, splitFrontmatter } from '@dfai/domain';
import { refreshIndex } from '../index/refresh-index.ts';
import {
  jsonFrontmatterMarkdown as markdown,
  guardedVault as memoryVault,
  jsonFrontmatterNote as note,
} from '../testing/guarded-vault.ts';
import { editedBeforeTrash } from '../testing/edited-before-trash.ts';
import { sqliteIndexPort } from '../testing/sqlite-index.ts';
import {
  applyPeopleMerge,
  PeopleMergeChangedError,
  PeopleMergeRefusedError,
  peopleMergeSummary,
  previewPeopleMerge,
  type MergePanes,
  type MergePorts,
} from './merge-people.ts';

const p = createVaultPath;

function panes(dirty: Set<string> = new Set()) {
  const flushed: string[][] = [];
  const reloaded: string[] = [];
  const abandoned: string[][] = [];
  const open = new Set<string>();
  const editors: MergePanes = {
    state: (path) => (dirty.has(path) ? 'dirty' : open.has(path) ? 'clean' : 'closed'),
    flush: async (paths) => {
      flushed.push([...paths]);
    },
    abandon: (paths) => abandoned.push([...paths]),
    reload: (path) => reloaded.push(path),
  };
  return { editors, flushed, reloaded, abandoned, open, dirty };
}

const KEPT = 'People/Mara Quill.md';
const SHORT = 'Mara.md';
const TYPO = 'Inbox/Marra Quill.md';

const VAULT = {
  [KEPT]: note(
    { type: 'person', email: 'mara.quill@larkspur.example.com', role: 'Payroll lead' },
    '# Mara Quill\n\nLeads payroll.\n',
  ),
  [SHORT]: note(
    { type: 'person', email: 'mara@larkspur.example.com', role: 'Analyst', aliases: ['MQ'] },
    'Met at the [[Kickoff]]. See [[Mara#Notes]].\n',
  ),
  [TYPO]: note(
    { type: 'person', email: 'marra.quill@larkspur.example.com' },
    '![badge](badge.png)\n',
  ),
  'Inbox/badge.png': '',
  'Kickoff.md': note(
    { type: 'meeting', attendees: ['[[Mara]]', '[[Tobias Fenn]]'] },
    'With [[Mara|M]] and ![[Marra Quill#^b1]]; also [[Mara Quill]].\n',
  ),
  'Plan.md': 'Ask [[Marra Quill]].\n',
  'Tobias Fenn.md': note({ type: 'person' }, 'Works with [[Mara Quillon]].\n'),
  'Mara Quillon.md': note({ type: 'person' }, 'Someone else.\n'),
};

async function setUp(entries: Record<string, string> = VAULT, dirty?: Set<string>) {
  const vault = memoryVault(entries);
  const index = sqliteIndexPort();
  await refreshIndex({ fs: vault.fs, index, markdown });
  const pane = panes(dirty);
  const ports: MergePorts = { fs: vault.fs, index, markdown, editors: pane.editors };
  const notePaths = Object.keys(entries)
    .filter((path) => path.endsWith('.md'))
    .map(p);
  const preview = (merge: string[] = [SHORT, TYPO], keep = KEPT) =>
    previewPeopleMerge({ ports, request: { keep: p(keep), merge: merge.map(p) }, notePaths });
  return { vault, index, pane, ports, preview };
}

describe('previewing a merge of people', () => {
  it('counts the notes and links that change, and lists conflicting values, writing nothing', async () => {
    const { vault, preview } = await setUp();
    const shown = await preview();
    expect(shown.refusal).toBeNull();
    expect(shown.writes.map((write) => [write.path, write.links])).toEqual([
      ['Kickoff.md', 3],
      ['Plan.md', 1],
      [KEPT, 1],
    ]);
    expect(shown.links).toBe(5);
    expect(shown.plan?.conflicts).toEqual([
      { key: 'role', kept: 'Payroll lead', other: 'Analyst', from: SHORT },
    ]);
    expect(shown.plan?.aliasesAdded).toEqual(['Mara', 'MQ', 'Marra Quill']);
    expect(vault.writes).toEqual([]);
    expect(vault.trashed).toEqual([]);
  });

  it('refuses a note that is not a person, or one that is not there, with nothing to write', async () => {
    const { preview } = await setUp();
    expect((await preview(['Plan.md'])).refusal).toBe('Plan is not a person.');
    const missing = await preview(['Gone.md']);
    expect(missing.refusal).toBe('Gone is not there, or cannot be read.');
    expect(missing.writes).toEqual([]);
  });

  it('refuses a person whose properties cannot be read', async () => {
    const { preview } = await setUp({ ...VAULT, [SHORT]: '---\nBROKEN\n---\nBody\n' });
    expect((await preview([SHORT])).refusal).toBe('Mara’s properties can’t be read: a bad line');
  });

  it('saves typing in a pane on any note it touches first, and refuses while some is still unsaved', async () => {
    const { pane, preview } = await setUp(VAULT, new Set(['Plan.md']));
    const shown = await preview();
    expect(pane.flushed).toEqual([['Plan.md']]);
    expect(shown.refusal).toBe('Plan.md has unsaved changes. Save them first.');
  });
});

describe('making a merge of people', () => {
  it('re-points every link, merges the kept note, and puts the merged people in the Trash', async () => {
    const { vault, preview, ports, index } = await setUp();
    const report = await applyPeopleMerge({ ports, preview: await preview() });

    expect(vault.text('Kickoff.md')).toBe(
      note(
        { type: 'meeting', attendees: ['[[Mara Quill]]', '[[Tobias Fenn]]'] },
        'With [[Mara Quill|M]] and ![[Mara Quill#^b1]]; also [[Mara Quill]].\n',
      ),
    );
    expect(vault.text('Plan.md')).toBe('Ask [[Mara Quill]].\n');
    expect(vault.text('Tobias Fenn.md')).toBe(VAULT['Tobias Fenn.md']);

    const kept = vault.text(KEPT)!;
    const { frontmatter, body } = splitFrontmatter(kept);
    expect(markdown.frontmatterProperties(frontmatter)).toEqual({
      type: 'person',
      email: 'mara.quill@larkspur.example.com',
      role: 'Payroll lead',
      other_emails: ['mara@larkspur.example.com', 'marra.quill@larkspur.example.com'],
      aliases: ['Mara', 'MQ', 'Marra Quill'],
    });
    expect(body).toBe(
      '# Mara Quill\n\nLeads payroll.\n\n' +
        '## Merged from Mara\n\nMet at the [[Kickoff]]. See [[Mara Quill#Notes]].\n\n' +
        '## Merged from Marra Quill\n\n![badge](../Inbox/badge.png)\n',
    );

    expect(report).toEqual({
      keep: KEPT,
      written: ['Kickoff.md', 'Plan.md', KEPT],
      notWritten: [],
      trashed: [SHORT, TYPO],
      notTrashed: [],
      failures: [],
      links: 5,
    });
    expect(vault.trashed).toEqual([SHORT, TYPO]);
    const left = await index.query('SELECT path FROM files WHERE path IN (?, ?)', [SHORT, TYPO]);
    expect(left.rows).toEqual([]);
  });

  it('writes each file once, the notes linking first and the kept note last', async () => {
    const { vault, preview, ports } = await setUp();
    await applyPeopleMerge({ ports, preview: await preview() });
    expect(vault.writes).toEqual(['Kickoff.md', 'Plan.md', KEPT]);
  });

  it('reads a clean pane again, and lets go of panes on the merged people', async () => {
    const { pane, preview, ports } = await setUp();
    pane.open.add('Plan.md');
    await applyPeopleMerge({ ports, preview: await preview() });
    expect(pane.reloaded).toEqual(['Plan.md']);
    expect(pane.abandoned).toEqual([[SHORT, TYPO]]);
  });

  it('writes nothing when a note changed after the preview, and says which', async () => {
    const { vault, preview, ports } = await setUp();
    const shown = await preview();
    vault.edit('Plan.md', 'Ask [[Marra Quill]] again.\n');
    vault.edit(SHORT, 'Changed.\n');
    const merging = applyPeopleMerge({ ports, preview: shown });
    await expect(merging).rejects.toThrow(PeopleMergeChangedError);
    await expect(merging).rejects.toThrow('Mara.md, Plan.md changed after the merge was previewed');
    expect(vault.writes).toEqual([]);
    expect(vault.trashed).toEqual([]);
  });

  it('writes nothing while a pane is being typed in on a note it would write', async () => {
    const { pane, preview, ports, vault } = await setUp();
    const shown = await preview();
    pane.dirty.add(KEPT);
    await expect(applyPeopleMerge({ ports, preview: shown })).rejects.toThrow(
      PeopleMergeChangedError,
    );
    expect(vault.writes).toEqual([]);
  });

  it('refuses a refused preview', async () => {
    const { preview, ports } = await setUp();
    await expect(applyPeopleMerge({ ports, preview: await preview(['Plan.md']) })).rejects.toThrow(
      PeopleMergeRefusedError,
    );
  });

  it('stops at a failed write, says what was and was not changed, and keeps every merged person', async () => {
    const { vault, preview, ports } = await setUp();
    vault.failWrite.add('Plan.md');
    const report = await applyPeopleMerge({ ports, preview: await preview() });
    expect(report).toEqual({
      keep: KEPT,
      written: ['Kickoff.md'],
      notWritten: ['Plan.md', KEPT],
      trashed: [],
      notTrashed: [SHORT, TYPO],
      failures: [{ path: 'Plan.md', step: 'write', reason: 'The disk is full.' }],
      links: 3,
    });
    // Each file whole: one rewritten through, the rest exactly as they were.
    expect(vault.text('Kickoff.md')).toContain('[[Mara Quill|M]]');
    expect(vault.text('Plan.md')).toBe(VAULT['Plan.md']);
    expect(vault.text(KEPT)).toBe(VAULT[KEPT]);
    expect(vault.text(SHORT)).toBe(VAULT[SHORT]);
  });

  it('picks up where a failed merge stopped when previewed again, merging the kept note once', async () => {
    const { vault, preview, ports, index } = await setUp();
    vault.failWrite.add('Plan.md');
    await applyPeopleMerge({ ports, preview: await preview() });
    vault.failWrite.clear();
    await refreshIndex({ fs: vault.fs, index, markdown });
    const again = await preview();
    expect(again.writes.map((write) => write.path)).toEqual(['Plan.md', KEPT]);
    await applyPeopleMerge({ ports, preview: again });
    expect(vault.text(KEPT)!.match(/## Merged from Mara\n/g)).toHaveLength(1);
    expect(vault.trashed).toEqual([SHORT, TYPO]);
  });

  it('reports a merged person the Trash refused, and still trashes the others', async () => {
    const { vault, preview, ports } = await setUp();
    vault.failTrash.add(SHORT);
    const report = await applyPeopleMerge({ ports, preview: await preview() });
    expect(report.trashed).toEqual([TYPO]);
    expect(report.notTrashed).toEqual([SHORT]);
    expect(report.failures).toEqual([
      { path: SHORT, step: 'trash', reason: 'The Trash refused it.' },
    ]);
    expect(report.written).toHaveLength(3);
  });

  it('merges the same name from two folders, where links already open the kept one', async () => {
    const root = 'Tobias Fenn.md';
    const people = 'People/Tobias Fenn.md';
    const { vault, ports } = await setUp({
      [root]: note({ type: 'person', email: 'tobias@fenn.example' }, 'Root copy.\n'),
      [people]: note({ type: 'person' }, 'Filed copy.\n'),
      'Deal.md': 'Signed by [[Tobias Fenn]].\n',
    });
    const notePaths = [root, people, 'Deal.md'].map(p);
    const shown = await previewPeopleMerge({
      ports,
      request: { keep: p(people), merge: [p(root)] },
      notePaths,
    });
    expect(shown.writes.map((write) => write.path)).toEqual([people]);
    await applyPeopleMerge({ ports, preview: shown });
    expect(vault.text('Deal.md')).toBe('Signed by [[Tobias Fenn]].\n');
    expect(splitFrontmatter(vault.text(people)!).body).toBe(
      'Filed copy.\n\n## Merged from Tobias Fenn\n\nRoot copy.\n',
    );
    expect(
      markdown.frontmatterProperties(splitFrontmatter(vault.text(people)!).frontmatter),
    ).toEqual({
      type: 'person',
      email: 'tobias@fenn.example',
    });
  });
});

describe('what a merge says it did', () => {
  const base = {
    keep: p(KEPT),
    written: [p('Kickoff.md'), p(KEPT)],
    notWritten: [],
    trashed: [p(SHORT), p(TYPO)],
    notTrashed: [],
    failures: [],
    links: 4,
  };

  it('names who went into whom and how many links moved', () => {
    expect(peopleMergeSummary(base)).toBe(
      'Merged Mara, Marra Quill into Mara Quill: 4 links now open Mara Quill.',
    );
  });

  it('says what was and was not written when a write stopped it', () => {
    expect(
      peopleMergeSummary({
        ...base,
        written: [p('Kickoff.md')],
        notWritten: [p('Plan.md'), p(KEPT)],
        trashed: [],
        notTrashed: [p(SHORT)],
        failures: [{ path: p('Plan.md'), step: 'write', reason: 'The disk is full.' }],
      }),
    ).toBe(
      'The merge into Mara Quill stopped: Plan.md could not be written (The disk is full.). ' +
        'Written: Kickoff.md. Not written: Plan.md, People/Mara Quill.md. Nobody went to the Trash.',
    );
  });

  it('names a merged person the Trash refused', () => {
    expect(
      peopleMergeSummary({
        ...base,
        links: 1,
        written: [p(KEPT)],
        trashed: [p(TYPO)],
        notTrashed: [p(SHORT)],
        failures: [{ path: p(SHORT), step: 'trash', reason: 'The Trash refused it.' }],
      }),
    ).toBe(
      'Merged Marra Quill into Mara Quill: 1 link now open Mara Quill. ' +
        'Still in the vault, as the Trash refused: Mara.md (The Trash refused it.).',
    );
  });
});

describe('finding every link before a merge (#467)', () => {
  it('saves typing in every pane and brings the index up first, so a link only just typed is found', async () => {
    const { vault, index, ports, pane } = await setUp();
    // `Notes.md` is open with `[[Mara]]` typed and not saved; `Outside.md` was written
    // by another program, and the index has not read it yet.
    vault.files.set('Notes.md', { text: 'Nothing yet.\n', modified: 1 });
    await refreshIndex({ fs: vault.fs, index, markdown });
    vault.files.set('Outside.md', { text: 'From the CRM: [[Marra Quill]].\n', modified: 1 });
    const refreshedFor: string[][] = [];
    let typing = [p('Notes.md')];
    const typed: MergePorts = {
      ...ports,
      editors: {
        ...pane.editors,
        dirtyPaths: () => typing,
        flush: async (paths) => {
          pane.flushed.push([...paths]);
          if (paths.includes(p('Notes.md'))) vault.edit('Notes.md', 'Call [[Mara]].\n');
          typing = [];
        },
      },
      refreshIndex: async (saved) => {
        refreshedFor.push([...saved]);
        await refreshIndex({ fs: vault.fs, index, markdown });
      },
    };
    const notePaths = [...vault.files.keys()].filter((path) => path.endsWith('.md')).map(p);
    const shown = await previewPeopleMerge({
      ports: typed,
      request: { keep: p(KEPT), merge: [p(SHORT), p(TYPO)] },
      notePaths,
    });
    expect(pane.flushed[0]).toEqual(['Notes.md']);
    expect(refreshedFor).toEqual([['Notes.md']]);
    expect(shown.writes.map((write) => write.path)).toEqual([
      'Kickoff.md',
      'Notes.md',
      'Outside.md',
      'Plan.md',
      KEPT,
    ]);
  });

  it('refuses while the index cannot catch up, rather than missing links', async () => {
    const { ports } = await setUp();
    const behind: MergePorts = {
      ...ports,
      refreshIndex: async () => {
        throw new Error('The index could not catch up.');
      },
    };
    await expect(
      previewPeopleMerge({
        ports: behind,
        request: { keep: p(KEPT), merge: [p(SHORT)] },
        notePaths: [p(KEPT), p(SHORT)],
      }),
    ).rejects.toThrow('The index could not catch up.');
  });

  it('rewrites a template that links to a merged person, as the person’s own words', async () => {
    const { vault, preview, ports } = await setUp({
      ...VAULT,
      '.atlas/templates/Brief.md': 'Ask [[Mara]] first.\n',
    });
    vault.fs.listDirectory = async (folder) =>
      folder === '.atlas/templates'
        ? [{ kind: 'file', name: 'Brief.md', path: p('.atlas/templates/Brief.md') }]
        : [];
    const shown = await preview();
    expect(shown.writes.map((write) => write.path)).toContain('.atlas/templates/Brief.md');
    await applyPeopleMerge({ ports, preview: shown });
    expect(vault.text('.atlas/templates/Brief.md')).toBe('Ask [[Mara Quill]] first.\n');
  });

  it('refuses while another of DFAI’s own files links to a merged person', async () => {
    const { preview, vault } = await setUp({
      ...VAULT,
      '.atlas/types/contact.md': 'Ask [[Mara]] about contacts.\n',
    });
    const shown = await preview([SHORT]);
    expect(shown.refusal).toBe(
      ".atlas/types/contact.md links to Mara but is one of DFAI's own files, which a merge does not rewrite. Change those links by hand, then merge.",
    );
    expect(vault.writes).toEqual([]);
  });

  it('gives the same version for the same files, and another once one changes', async () => {
    const { vault, preview } = await setUp();
    const first = await preview();
    expect((await preview()).version).toBe(first.version);
    vault.edit('Plan.md', 'Ask [[Marra Quill]] today.\n');
    expect((await preview()).version).not.toBe(first.version);
    expect((await preview(['Plan.md'])).version).toBe('');
  });

  it('leaves a merged person in place when their note changed while the merge was written', async () => {
    const { vault, preview, ports } = await setUp();
    const shown = await preview();
    const writeTextFile = vault.fs.writeTextFile;
    vault.fs.writeTextFile = async (args) => {
      const written = await writeTextFile(args);
      if (args.path === KEPT) vault.edit(SHORT, 'Changed meanwhile.\n');
      return written;
    };
    const report = await applyPeopleMerge({ ports, preview: shown });
    expect(report.trashed).toEqual([TYPO]);
    expect(report.notTrashed).toEqual([SHORT]);
    expect(report.failures[0]).toMatchObject({ path: SHORT, step: 'trash' });
    expect(vault.text(SHORT)).toBe('Changed meanwhile.\n');
  });

  it('leaves a merged person in place when their note changes between its check and the Trash (#693)', async () => {
    const { vault, preview, ports } = await setUp();
    const shown = await preview();
    const editing = editedBeforeTrash(vault.fs, () => vault.edit(SHORT, 'Changed meanwhile.\n'));
    const report = await applyPeopleMerge({ ports: { ...ports, fs: editing }, preview: shown });
    expect(report.trashed).toEqual([TYPO]);
    expect(report.notTrashed).toEqual([SHORT]);
    expect(report.failures).toEqual([
      {
        path: SHORT,
        step: 'trash',
        reason:
          'It changed while the merge was being written, so it was left where it is. Merge it again to take in the change.',
      },
    ]);
    expect(vault.text(SHORT)).toBe('Changed meanwhile.\n');
  });

  it('trashes every merged person left as checked, through the same hold (#693)', async () => {
    const { vault, preview, ports } = await setUp();
    const shown = await preview();
    const holding = editedBeforeTrash(vault.fs, () => undefined);
    const report = await applyPeopleMerge({ ports: { ...ports, fs: holding }, preview: shown });
    expect(report.trashed).toEqual([SHORT, TYPO]);
    expect(report.failures).toEqual([]);
  });
});

describe('saved views and dashboards linking to a merged person (#467)', () => {
  const VIEW = '.atlas/views/Mara’s meetings.md';
  const atlasFolders = (vault: ReturnType<typeof memoryVault>) => {
    vault.fs.listDirectory = async (folder) =>
      [...vault.files.keys()]
        .filter((path) => path.startsWith(`${folder}/`))
        .map((path) => ({ kind: 'file', name: path.split('/').at(-1)!, path: p(path) }));
  };

  it('re-points a view’s filter byte for byte, and counts the view in the preview', async () => {
    const view = '---\nfilters:\n  - owner is [[Mara]]   # hers\n---\n# Mara’s meetings\n';
    const { vault, preview, ports } = await setUp({ ...VAULT, [VIEW]: view });
    atlasFolders(vault);
    const shown = await preview([SHORT]);
    expect(shown.writes.find((write) => write.path === VIEW)?.links).toBe(1);
    await applyPeopleMerge({ ports, preview: shown });
    expect(vault.text(VIEW)).toBe(view.replace('[[Mara]]', '[[Mara Quill]]'));
  });

  it('refuses, naming the view, when it names a merged person by file where no link reaches', async () => {
    const view = '---\nsql: SELECT * FROM notes WHERE owner = \'Mara.md\' OR x = "[[Mara]]"\n---\n';
    const { vault, preview } = await setUp({ ...VAULT, [VIEW]: view });
    atlasFolders(vault);
    const shown = await preview([SHORT]);
    expect(shown.refusal).toBe(
      `${VIEW} names Mara by file, not by a link, so the merge cannot change it safely. Change it by hand, then merge.`,
    );
    expect(vault.writes).toEqual([]);
  });
});

describe('a dashboard naming a merged person with no link at all (#467)', () => {
  it('refuses, naming the dashboard', async () => {
    const BOARD = '.atlas/dashboards/Team.md';
    const { vault, preview } = await setUp({
      ...VAULT,
      [BOARD]: "---\nsql: SELECT * FROM notes WHERE owner = 'Mara.md'\n---\n",
    });
    vault.fs.listDirectory = async (folder) =>
      folder === '.atlas/dashboards' ? [{ kind: 'file', name: 'Team.md', path: p(BOARD) }] : [];
    expect((await preview([SHORT])).refusal).toContain(BOARD);
  });
});

describe('a view naming a person by file, as a whole path only (#467)', () => {
  it('does not read Diana.md as naming Ana.md, and still reads "Ana.md" quoted as naming it', async () => {
    const BOARD = '.atlas/dashboards/Team.md';
    const run = async (sql: string) => {
      const { vault, preview } = await setUp({
        ...VAULT,
        'Ana.md': note({ type: 'person' }, ''),
        'Diana.md': note({ type: 'person' }, ''),
        [BOARD]: `---\nsql: ${sql}\n---\n`,
      });
      vault.fs.listDirectory = async (folder) =>
        folder === '.atlas/dashboards' ? [{ kind: 'file', name: 'Team.md', path: p(BOARD) }] : [];
      return (await preview(['Ana.md'])).refusal;
    };
    expect(await run("SELECT * FROM notes WHERE owner = 'Diana.md'")).toBeNull();
    expect(await run("SELECT * FROM notes WHERE owner = 'Folder/Ana.md'")).toBeNull();
    expect(await run("SELECT * FROM notes WHERE owner = 'ana.md'")).toContain(BOARD);
    expect(await run('owner IN ("x.md", "Ana.md")')).toContain(BOARD);
  });
});
