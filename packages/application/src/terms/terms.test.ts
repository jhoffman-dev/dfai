import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { createVaultPath, VOCABULARY_PAGE_SIZE, type ObjectType } from '@dfai/domain';
import { fakeIndexPort, fakeMarkdown, fakeOpenNotes, fakeVaultFs } from '../testing/fake-ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { VaultAccessError } from '../vault/ports.ts';
import { addTerm, loadTerms, setTermVariants, TermRefusedError } from './terms.ts';

const path = (value: string) => createVaultPath(value);

/** An index whose `query` is SQLite over the index's own tables, holding these notes. */
function indexOf(
  notes: Record<string, { title: string; props: Record<string, string | string[]> }>,
) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER, size INTEGER NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);`);
  for (const [at, { title, props }] of Object.entries(notes)) {
    database
      .prepare('INSERT INTO files (path, title, modified, size) VALUES (?, ?, 1, 1)')
      .run(at, title);
    for (const [key, value] of Object.entries(props)) {
      (Array.isArray(value) ? value : [value]).forEach((item, idx) =>
        database
          .prepare('INSERT INTO props (path, key, idx, value_text) VALUES (?, ?, ?, ?)')
          .run(at, key, idx, item),
      );
    }
  }
  return fakeIndexPort({
    query: async (sql, parameters) => {
      const prepared = database.prepare(sql);
      const columns = prepared.columns().map((column) => column.name);
      const rows = (prepared.all(...parameters) as Record<string, unknown>[]).map((row) =>
        columns.map((column) => row[column]),
      );
      return { columns, rows, truncated: false };
    },
  });
}

describe('loadTerms', () => {
  it('lists the terms and builds the vocabulary from them and the vault’s people and companies', async () => {
    const index = indexOf({
      'Terms/Larkspur.md': {
        title: 'Larkspur',
        props: { type: 'term', kind: 'company', variants: ['lark spur'] },
      },
      'People/Mara Quill.md': {
        title: 'Mara Quill',
        props: { type: 'person', aliases: 'Mara Quil' },
      },
      'Companies/Fenn Ledger.md': { title: 'Fenn Ledger', props: { type: 'company' } },
      'Archive/Terms/Old.md': { title: 'Old', props: { type: 'term', variants: 'olde' } },
    });
    const { terms, vocabulary } = await loadTerms({ index });

    expect(terms).toEqual([
      {
        path: 'Terms/Larkspur.md',
        canonical: 'Larkspur',
        variants: ['lark spur'],
        kind: 'company',
      },
    ]);
    expect(vocabulary.entries.map((entry) => `${entry.form} → ${entry.canonical}`)).toEqual([
      'Fenn Ledger → Fenn Ledger',
      'Mara Quill → Mara Quill',
      'lark spur → Larkspur',
      'Larkspur → Larkspur',
    ]);
    expect(vocabulary.conflicts).toEqual([]);
  });

  it('lists the people and companies with misheard spellings beside the terms, which correct to their names (#400)', async () => {
    const index = indexOf({
      'Terms/Quill Desk.md': { title: 'Quill Desk', props: { type: 'term' } },
      'Companies/Larkspur Payroll.md': {
        title: 'Larkspur Payroll',
        props: { type: 'company', variants: 'Larkspar Payroll', aliases: 'LP' },
      },
      'People/Mara Quill.md': { title: 'Mara Quill', props: { type: 'person', aliases: 'Mara' } },
    });
    const { terms, listed, vocabulary } = await loadTerms({ index });

    expect(terms.map((term) => term.path)).toEqual(['Terms/Quill Desk.md']);
    expect(listed.map((row) => [row.path, row.source, row.variants])).toEqual([
      ['Companies/Larkspur Payroll.md', 'company', ['Larkspar Payroll']],
      ['Terms/Quill Desk.md', 'term', []],
    ]);
    expect(vocabulary.entries.map((entry) => `${entry.form} → ${entry.canonical}`)).toContain(
      'Larkspar Payroll → Larkspur Payroll',
    );
    expect(vocabulary.entries.map((entry) => entry.form)).not.toContain('LP');
  });

  it('shows a variant two terms claim as a conflict rather than using it', async () => {
    const index = indexOf({
      'Terms/Larkspur.md': { title: 'Larkspur', props: { type: 'term', variants: 'lark spur' } },
      'Terms/Larkspur Payroll.md': {
        title: 'Larkspur Payroll',
        props: { type: 'term', variants: ['lark spur'] },
      },
    });
    const { vocabulary } = await loadTerms({ index });
    expect(
      vocabulary.conflicts.map((conflict) => conflict.claims.map((claim) => claim.path)),
    ).toEqual([['Terms/Larkspur.md', 'Terms/Larkspur Payroll.md']]);
    expect(vocabulary.entries.map((entry) => entry.form)).not.toContain('lark spur');
  });

  it('reads on past a full page, until a page comes back short', async () => {
    const asked: number[] = [];
    const index = fakeIndexPort({
      query: async (_sql, parameters) => {
        const offset = Number(parameters.at(-1));
        asked.push(offset);
        const count = offset === 0 ? VOCABULARY_PAGE_SIZE : 1;
        const rows = Array.from({ length: count }, (_, at) => [
          `People/P${offset + at}.md`,
          `P${offset + at}`,
          'person',
          null,
          null,
        ]);
        return { columns: ['path', 'title', 'type', 'key', 'value'], rows, truncated: false };
      },
    });
    const { vocabulary } = await loadTerms({ index });
    expect(asked).toEqual([0, VOCABULARY_PAGE_SIZE]);
    expect(vocabulary.entries).toHaveLength(VOCABULARY_PAGE_SIZE + 1);
  });

  it('reads on when the host cut a page short, as it does at its row cap', async () => {
    const asked: number[] = [];
    const index = fakeIndexPort({
      query: async (_sql, parameters) => {
        const offset = Number(parameters.at(-1));
        asked.push(offset);
        return {
          columns: ['path', 'title', 'type', 'key', 'value'],
          rows: offset === 0 ? [['a.md', 'A', 'term', null, null]] : [],
          truncated: offset === 0,
        };
      },
    });
    expect((await loadTerms({ index })).terms.map((term) => term.canonical)).toEqual(['A']);
    expect(asked).toEqual([0, VOCABULARY_PAGE_SIZE]);
  });

  it('fails when the index cannot be read, rather than offering no vocabulary', async () => {
    const index = fakeIndexPort({
      query: async () => {
        throw new Error('index closed');
      },
    });
    await expect(loadTerms({ index })).rejects.toThrow('index closed');
  });
});

/** A vault that records what is made in it, and the frontmatter changes a write asked for. */
function recordingVault(
  files: Readonly<Record<string, string>> = {},
  top: readonly { name: string; kind: 'file' | 'directory' }[] = [],
) {
  const created: { path: string; contents: string }[] = [];
  const written: { path: string; contents: string }[] = [];
  const folders: string[] = [];
  const changes: Readonly<Record<string, unknown>>[] = [];
  const fs = fakeVaultFs({
    listDirectory: async () => top.map((entry) => ({ ...entry, path: path(entry.name) })),
    createFolder: async ({ path: at }) => {
      folders.push(at);
    },
    createNote: async ({ path: at, contents }) => {
      created.push({ path: at, contents });
      return 0;
    },
    readTextFile: async (at) => {
      const text = files[at];
      if (text === undefined) throw new VaultAccessError(`no file ${at}`);
      return { text, modified: 7 };
    },
    writeTextFile: async ({ path: at, contents }) => {
      written.push({ path: at, contents });
      return 8;
    },
  });
  const fake = fakeMarkdown();
  const markdown: MarkdownPort = {
    ...fake,
    updateFrontmatter: (frontmatter, change) => {
      changes.push(change);
      return fake.updateFrontmatter(frontmatter, change);
    },
  };
  return { fs, markdown, created, written, folders, changes };
}

const TERM_TYPE: ObjectType = { name: 'term', label: 'Term', properties: [] };
const NO_PANES = fakeOpenNotes();
const TODAY = '2026-10-19';

describe('addTerm', () => {
  it('writes a note of type term in Terms/, with its variants and kind, making the folder', async () => {
    const vault = recordingVault();
    const made = await addTerm({
      fs: vault.fs,
      markdown: vault.markdown,
      openNotes: NO_PANES,
      today: TODAY,
      term: { canonical: 'Larkspur', variants: 'lark spur, Larks Burr', kind: 'company' },
      types: [TERM_TYPE],
      templates: [],
      notePaths: [],
    });
    expect(made.path).toBe('Terms/Larkspur.md');
    expect(vault.folders).toEqual(['Terms']);
    expect(vault.changes).toEqual([
      { type: 'term', kind: 'company', variants: ['lark spur', 'Larks Burr'] },
    ]);
    expect(vault.created).toEqual([
      {
        path: 'Terms/Larkspur.md',
        contents: '---\ntype: term\nkind: company\nvariants: lark spur,Larks Burr\n---\n',
      },
    ]);
  });

  it('starts from the vault’s Term template, in the Terms folder as the vault spells it', async () => {
    const vault = recordingVault(
      { '.atlas/templates/Term.md': '---\ntype: term\nkind: other\n---\n\nHeard in:\n' },
      [{ name: 'terms', kind: 'directory' }],
    );
    const made = await addTerm({
      fs: vault.fs,
      markdown: vault.markdown,
      openNotes: NO_PANES,
      today: TODAY,
      term: { canonical: 'QLX', variants: '', kind: 'acronym' },
      types: [],
      templates: [{ path: path('.atlas/templates/Term.md'), name: 'Term' }],
      notePaths: [],
    });
    expect(made.path).toBe('terms/QLX.md');
    expect(vault.folders).toEqual([]);
    expect(vault.created[0]?.contents).toBe('---\ntype: term\nkind: acronym\n---\n\nHeard in:\n');
  });

  it('keeps a spelling no file name can hold, or one already taken, as the title', async () => {
    // Terms/Larkspur.md is what `[[Larkspur]]` opens, and it is a term: a new one is numbered.
    const vault = recordingVault({ 'Terms/Larkspur.md': '---\ntype: term\n---\n' }, [
      { name: 'Terms', kind: 'directory' },
    ]);
    const make = (canonical: string) =>
      addTerm({
        fs: vault.fs,
        markdown: vault.markdown,
        openNotes: NO_PANES,
        today: TODAY,
        term: { canonical, variants: '', kind: null },
        types: [TERM_TYPE],
        templates: [],
        notePaths: [path('Terms/Larkspur.md')],
      });
    expect((await make('S/4 Ledger')).path).toBe('Terms/S 4 Ledger.md');
    expect((await make('Larkspur')).path).toBe('Terms/Larkspur 2.md');
    expect(vault.changes).toEqual([
      { type: 'term', title: 'S/4 Ledger' },
      { type: 'term', title: 'Larkspur' },
    ]);
  });

  it('names the note by its spelling without the zero-width characters pasted text carries', async () => {
    const vault = recordingVault({}, [{ name: 'Terms', kind: 'directory' }]);
    const made = await addTerm({
      fs: vault.fs,
      markdown: vault.markdown,
      openNotes: NO_PANES,
      today: TODAY,
      term: { canonical: ' Lark\u200Bspur\uFEFF', variants: '', kind: null },
      types: [TERM_TYPE],
      templates: [],
      notePaths: [],
    });
    expect(made.path).toBe('Terms/Larkspur.md');
    expect(vault.changes).toEqual([{ type: 'term' }]);
  });

  it('refuses a term with no spelling, and writes nothing', async () => {
    const vault = recordingVault();
    await expect(
      addTerm({
        fs: vault.fs,
        markdown: vault.markdown,
        openNotes: NO_PANES,
        today: TODAY,
        term: { canonical: '   ', variants: 'x', kind: null },
        types: [],
        templates: [],
        notePaths: [],
      }),
    ).rejects.toThrow(new TermRefusedError('A term needs its right spelling.'));
    expect(vault.created).toEqual([]);
    expect(vault.folders).toEqual([]);
  });

  it('refuses a term whose note would take over links to another note of that name', async () => {
    const vault = recordingVault({ 'Zeta/Larkspur.md': '---\ntype: project\n---\n' }, [
      { name: 'Terms', kind: 'directory' },
    ]);
    await expect(
      addTerm({
        fs: vault.fs,
        markdown: vault.markdown,
        openNotes: NO_PANES,
        today: TODAY,
        term: { canonical: 'Larkspur', variants: '', kind: null },
        types: [],
        templates: [],
        // Terms/Larkspur.md would sort before Zeta/Larkspur.md, and win `[[Larkspur]]`.
        notePaths: [path('Zeta/Larkspur.md'), path('A.md')],
      }),
    ).rejects.toThrow(
      // Said once: the Terms page puts “Larkspur” was not added in front of it (#400).
      new TermRefusedError(
        '[[Larkspur]] already opens Zeta/Larkspur.md, and would open the new term instead. Rename one of them first.',
      ),
    );
    expect(vault.created).toEqual([]);
    expect(vault.written).toEqual([]);
  });

  describe('named like a person or a company already in the vault (#400)', () => {
    const COMPANY = [
      '---',
      'type: company',
      'site: https://larkspur.example',
      'variants: larkspar',
      '---',
      '',
      'Payroll vendor.',
      '',
    ].join('\n');

    const addTo = (
      vault: ReturnType<typeof recordingVault>,
      term: { canonical: string; variants: string },
      notePaths: readonly string[],
      openNotes = NO_PANES,
    ) =>
      addTerm({
        fs: vault.fs,
        markdown: vault.markdown,
        openNotes,
        today: TODAY,
        term: { ...term, kind: 'company' },
        types: [TERM_TYPE],
        templates: [],
        notePaths: notePaths.map(path),
      });

    it('adds the misheard spellings to the company the name opens, the rest of it as it was', async () => {
      const vault = recordingVault({ 'Companies/Larkspur Payroll.md': COMPANY }, [
        { name: 'Terms', kind: 'directory' },
      ]);
      const added = await addTo(
        vault,
        { canonical: 'Larkspur Payroll', variants: 'larkspar, Larks Burr Payroll' },
        ['Companies/Larkspur Payroll.md', 'A.md'],
      );
      expect(added).toEqual({
        path: 'Companies/Larkspur Payroll.md',
        into: 'company',
        added: ['Larks Burr Payroll'],
      });
      expect(vault.created).toEqual([]);
      expect(vault.folders).toEqual([]);
      expect(vault.written).toEqual([
        {
          path: 'Companies/Larkspur Payroll.md',
          contents: COMPANY.replace('variants: larkspar', 'variants: larkspar,Larks Burr Payroll'),
        },
      ]);
    });

    it('adds them to a person the name opens, through the pane that holds the note when one does', async () => {
      const person = '---\ntype: person\naliases: Toby\n---\n\nMet at the offsite.\n';
      const vault = recordingVault({ 'People/Tobias Fenn.md': person });
      const given: unknown[] = [];
      const panes = fakeOpenNotes({
        setPropertiesIfOpen: async ({ values }) => {
          given.push(typeof values === 'function' ? values({ aliases: 'Toby' }) : values);
          return true;
        },
      });
      const added = await addTo(
        vault,
        { canonical: 'Tobias Fenn', variants: 'Tobias Fen' },
        ['People/Tobias Fenn.md'],
        panes,
      );
      expect(added).toEqual({
        path: 'People/Tobias Fenn.md',
        into: 'person',
        added: ['Tobias Fen'],
      });
      expect(given).toEqual([{ variants: ['Tobias Fen'] }]);
      expect(vault.written).toEqual([]);
    });

    it('writes nothing when the company already lists every spelling given', async () => {
      const vault = recordingVault({ 'Companies/Larkspur Payroll.md': COMPANY });
      const added = await addTo(vault, { canonical: 'Larkspur Payroll', variants: 'larkspar' }, [
        'Companies/Larkspur Payroll.md',
      ]);
      expect(added).toEqual({ path: 'Companies/Larkspur Payroll.md', into: 'company', added: [] });
      expect(vault.written).toEqual([]);
    });

    it('never adds to an archived company, which the vocabulary does not read, and refuses as before (#404)', async () => {
      const archived = 'Archive/Areas/Larkspur Payroll.md';
      const vault = recordingVault({ [archived]: COMPANY }, [{ name: 'Terms', kind: 'directory' }]);
      await expect(
        addTo(vault, { canonical: 'Larkspur Payroll', variants: 'Larks Burr Payroll' }, [archived]),
      ).rejects.toThrow(
        new TermRefusedError(
          `[[Larkspur Payroll]] already opens ${archived}, and would open the new term instead. Rename one of them first.`,
        ),
      );
      expect(vault.written).toEqual([]);
      expect(vault.created).toEqual([]);
    });

    it('refuses a spelling that is the company’s only once case is folded, saying how the note spells it (#404)', async () => {
      const vault = recordingVault({ 'Companies/Larkspur Payroll.md': COMPANY });
      await expect(
        addTo(vault, { canonical: 'LARKSPUR  payroll', variants: 'Larks Burr Payroll' }, [
          'Companies/Larkspur Payroll.md',
        ]),
      ).rejects.toThrow(
        new TermRefusedError(
          'Companies/Larkspur Payroll.md is spelt “Larkspur Payroll”. Add the term as “Larkspur Payroll”, or rename the note first.',
        ),
      );
      expect(vault.written).toEqual([]);
    });

    it('takes the company’s right spelling from its title property when it has one (#404)', async () => {
      const titled = COMPANY.replace('type: company', 'type: company\ntitle: Larkspur Payroll Co');
      const vault = recordingVault({ 'Companies/Larkspur Payroll.md': titled });
      await expect(
        addTo(vault, { canonical: 'Larkspur Payroll', variants: 'Larks Burr Payroll' }, [
          'Companies/Larkspur Payroll.md',
        ]),
      ).rejects.toThrow(
        /is titled “Larkspur Payroll Co”, but \[\[Larkspur Payroll\]\] opens it by its file name/,
      );
    });

    it('refuses a variants that is not a list before writing anything, the panes not asked (#404)', async () => {
      const vault = recordingVault({ 'Companies/Larkspur Payroll.md': COMPANY });
      const mapped: MarkdownPort = {
        ...vault.markdown,
        frontmatterProperties: () => ({ type: 'company', variants: { heard: 'larkspar' } }),
      };
      const setPropertiesIfOpen = vi.fn(async () => true);
      await expect(
        addTerm({
          fs: vault.fs,
          markdown: mapped,
          openNotes: fakeOpenNotes({ setPropertiesIfOpen }),
          today: TODAY,
          term: { canonical: 'Larkspur Payroll', variants: 'Larks Burr Payroll', kind: null },
          types: [TERM_TYPE],
          templates: [],
          notePaths: [path('Companies/Larkspur Payroll.md')],
        }),
      ).rejects.toThrow(/has a variants that is not a list/);
      expect(setPropertiesIfOpen).not.toHaveBeenCalled();
      expect(vault.written).toEqual([]);
    });

    it('refuses at the write a variants that became something else since it was read (#404)', async () => {
      const vault = recordingVault({ 'Companies/Larkspur Payroll.md': COMPANY });
      const panes = fakeOpenNotes({
        setPropertiesIfOpen: async ({ values }) => {
          if (typeof values === 'function') values({ variants: 7 });
          return true;
        },
      });
      await expect(
        addTo(
          vault,
          { canonical: 'Larkspur Payroll', variants: 'Larks Burr Payroll' },
          ['Companies/Larkspur Payroll.md'],
          panes,
        ),
      ).rejects.toThrow(
        new TermRefusedError(
          "Companies/Larkspur Payroll.md has a variants that is not a list, so misheard spellings can't be added to it. Make it a list first.",
        ),
      );
    });

    it('refuses cleanly when the note the name opened is gone since the vault was read (#404)', async () => {
      const vault = recordingVault({}, [{ name: 'Terms', kind: 'directory' }]);
      await expect(
        addTo(vault, { canonical: 'Larkspur Payroll', variants: 'Larks Burr Payroll' }, [
          'Companies/Larkspur Payroll.md',
        ]),
      ).rejects.toBeInstanceOf(TermRefusedError);
      expect(vault.created).toEqual([]);
    });

    it('refuses a company name given no misheard spellings, since the name already spells itself', async () => {
      const vault = recordingVault({ 'Companies/Larkspur Payroll.md': COMPANY });
      await expect(
        addTo(vault, { canonical: 'Larkspur Payroll', variants: ' , ' }, [
          'Companies/Larkspur Payroll.md',
        ]),
      ).rejects.toThrow(
        new TermRefusedError(
          'Companies/Larkspur Payroll.md already spells it. Give the misheard spellings to add to it.',
        ),
      );
      expect(vault.written).toEqual([]);
      expect(vault.created).toEqual([]);
    });
  });

  it('refuses when Terms is a file, so there is nowhere to put it', async () => {
    const vault = recordingVault({}, [{ name: 'Terms', kind: 'file' }]);
    await expect(
      addTerm({
        fs: vault.fs,
        markdown: vault.markdown,
        openNotes: NO_PANES,
        today: TODAY,
        term: { canonical: 'Larkspur', variants: '', kind: null },
        types: [],
        templates: [],
        notePaths: [],
      }),
    ).rejects.toThrow('Terms is a file, so terms have nowhere to go');
  });
});

describe('setTermVariants', () => {
  it('writes the variants into the frontmatter only, the body as it was', async () => {
    const before = '---\ntype: term\nvariants: old\n---\n\nHeard in the **standup**.\n';
    const vault = recordingVault({ 'Terms/Larkspur.md': before });
    await setTermVariants({
      fs: vault.fs,
      markdown: vault.markdown,
      path: path('Terms/Larkspur.md'),
      variants: 'lark spur,  lark  spur, Larks Burr',
      today: '2026-10-08',
    });
    expect(vault.changes).toEqual([{ variants: ['lark spur', 'Larks Burr'] }]);
    expect(vault.written).toEqual([
      {
        path: 'Terms/Larkspur.md',
        contents:
          '---\ntype: term\nvariants: lark spur,Larks Burr\n---\n\nHeard in the **standup**.\n',
      },
    ]);
  });

  it('empties the list when every variant is taken out', async () => {
    const vault = recordingVault({ 'Terms/Larkspur.md': '---\ntype: term\nvariants: old\n---\n' });
    await setTermVariants({
      fs: vault.fs,
      markdown: vault.markdown,
      path: path('Terms/Larkspur.md'),
      variants: ' , ',
      today: '2026-10-08',
    });
    expect(vault.changes).toEqual([{ variants: [] }]);
  });
});
