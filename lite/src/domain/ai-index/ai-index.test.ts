import { buildAiIndex, type IndexFile } from './index.ts';

const VAULT: readonly IndexFile[] = [
  { path: 'People/Mara Quill.md', text: 'Mara leads payroll at [[Larkspur Payroll]]. #person\n' },
  { path: 'People/Tobias Fenn.md', text: 'Tobias runs the rollout. #person\n' },
  {
    path: 'Projects/Larkspur rollout.md',
    text: '# Rollout\n\nMoving Larkspur Payroll to the new ledger. More after. #project #area/finance\n\nSee [[Mara Quill]], [[Mara Quill|Mara]] and [[Ghost note]].\n',
  },
  {
    path: 'Meetings/2026/11/2026-11-21 Weekly sync.md',
    text: 'We agreed the cutover date. #meeting\n\n- When: 2026-11-21 10:00\n- With: [[Mara Quill]], [[Tobias Fenn]]\n- About: [[Larkspur rollout]]\n',
  },
  {
    path: 'Meetings/2026/10/2026-10-02 Kickoff.md',
    text: 'First look at the plan. #meeting\n\n- With: [[Tobias Fenn]]\n',
  },
  { path: 'Meetings/2026/11/2026-11-03 Planning.md', text: 'Planned. #meeting\n' },
  {
    path: 'Meetings/Loose notes.md',
    text: 'Nothing dated. #meeting\n\n- With: the payroll team\n',
  },
  { path: 'Inbox/Idea (conflict 2026-11-20).md', text: 'An idea worth keeping.\n' },
  { path: 'Root note.md', text: 'At the root, linking [[Larkspur rollout]].\n' },
  { path: '_index/README.md', text: 'stale index' },
  { path: 'CLAUDE.md', text: 'How Claude works in this vault.\n' },
  { path: 'README.md', text: 'About this vault.\n' },
  { path: '.dfai-lite/notes.md', text: 'app state' },
  { path: 'Resources/diagram.png', text: 'not markdown' },
];

const files = buildAiIndex(VAULT);
const file = (path: string): string => {
  const found = files.find((candidate) => candidate.path === path);
  if (found === undefined) throw new Error(`no ${path} in ${files.map((f) => f.path).join(', ')}`);
  return found.text;
};
const lineOf = (text: string, start: string): string | undefined =>
  text.split('\n').find((line) => line.startsWith(start));

describe('buildAiIndex', () => {
  it('writes the README, a file per top-level folder, tags and a file per meeting month', () => {
    expect(files.map(({ path }) => path)).toEqual([
      '_index/README.md',
      '_index/folders/Inbox.md',
      '_index/folders/Meetings.md',
      '_index/folders/People.md',
      '_index/folders/Projects.md',
      '_index/folders/_root.md',
      '_index/meetings/2026-10.md',
      '_index/meetings/2026-11.md',
      '_index/meetings/undated.md',
      '_index/tags.md',
    ]);
  });

  it('leaves hidden paths and non-markdown files out', () => {
    const all = files.map(({ text }) => text).join('');
    expect(all).not.toContain('stale index');
    expect(all).not.toContain('.dfai-lite');
    expect(all).not.toContain('diagram.png');
  });

  it('leaves the vault’s own root CLAUDE.md and README.md out', () => {
    const all = files.map(({ text }) => text).join('');
    expect(all).not.toContain('How Claude works');
    expect(all).not.toContain('About this vault');
  });

  it('gives a note its tags, links out, backlinks and first sentence on one line', () => {
    expect(lineOf(file('_index/folders/Projects.md'), 'Projects/')).toBe(
      'Projects/Larkspur rollout.md | #project #area/finance | → [[Mara Quill]] [[Ghost note]] | ← 2: [[2026-11-21 Weekly sync]] [[Root note]] | Moving Larkspur Payroll to the new ledger.',
    );
    expect(lineOf(file('_index/folders/People.md'), 'People/Mara')).toBe(
      'People/Mara Quill.md | #person | → [[Larkspur Payroll]] | ← 2: [[2026-11-21 Weekly sync]] [[Larkspur rollout]] | Mara leads payroll at Larkspur Payroll.',
    );
  });

  it('heads each folder file with its count and the line format, once', () => {
    const [heading, format] = file('_index/folders/People.md').split('\n');
    expect(heading).toBe('# People/ — 2 notes');
    expect(format).toMatch(/^Line: path \| #tags \| → links out/);
  });

  it('puts root notes in _root.md and flags conflict copies', () => {
    expect(file('_index/folders/_root.md')).toContain(
      'Root note.md | → [[Larkspur rollout]] | At the root',
    );
    expect(lineOf(file('_index/folders/Inbox.md'), 'Inbox/')).toBe(
      'Inbox/Idea (conflict 2026-11-20).md | ! conflict copy | An idea worth keeping.',
    );
    expect(file('_index/README.md')).toContain('## Conflict copies\n');
  });

  it('cuts a long first sentence to about 140 characters', () => {
    const long = `${'word '.repeat(60).trim()}.`;
    const [, , line] =
      buildAiIndex([{ path: 'Inbox/Long.md', text: long }])
        .find(({ path }) => path === '_index/folders/Inbox.md')
        ?.text.split('\n') ?? [];
    const summary = line?.split(' | ').at(-1) ?? '';
    expect(summary.length).toBeLessThanOrEqual(140);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('caps a long list of links out with +N', () => {
    const links = Array.from(
      { length: 12 },
      (_, at) => `[[Target ${String(at).padStart(2, '0')}]]`,
    );
    const [only] = buildAiIndex([{ path: 'Hub.md', text: `Hub. ${links.join(' ')}` }]).filter(
      ({ path }) => path === '_index/folders/_root.md',
    );
    expect(only?.text).toContain('[[Target 07]] +4 | Hub.');
  });

  it('maps the vault in the README: folders with counts and files, total, months and tags', () => {
    const readme = file('_index/README.md');
    expect(
      readme
        .split('\n')
        .slice(0, 4)
        .every((line) => line !== ''),
    ).toBe(true);
    expect(readme).toContain('\n9 notes.\n');
    expect(readme).toContain('Meetings/ | 4 | _index/folders/Meetings.md\n');
    expect(readme).toContain('(vault root) | 1 | _index/folders/_root.md\n');
    expect(readme).toContain('2026-11 | 2 | _index/meetings/2026-11.md\n');
    expect(readme).toContain('undated | 1 | _index/meetings/undated.md\n');
    expect(readme).toContain('#area (1) #area/finance (1) #meeting (4) #person (2) #project (1)');
  });

  it('points to tags.md instead of listing many tags', () => {
    const notes = Array.from({ length: 50 }, (_, at) => ({
      path: `N${at}.md`,
      text: `Note. #tag${at}`,
    }));
    expect(buildAiIndex(notes)[0]?.text).toContain('50 tags: see _index/tags.md.');
  });

  it('lists each tag with its notes, nested tags under their parent', () => {
    const tags = file('_index/tags.md').split('\n');
    expect(tags).toContain('#area (1)');
    expect(tags).toContain('  #area/finance (1): Projects/Larkspur rollout.md');
    expect(tags).toContain('#person (2): People/Mara Quill.md | People/Tobias Fenn.md');
    expect(tags.indexOf('#area (1)')).toBeLessThan(
      tags.indexOf('  #area/finance (1): Projects/Larkspur rollout.md'),
    );
  });

  it('lists meetings by month, by date: title, who, about, first sentence', () => {
    expect(file('_index/meetings/2026-11.md').split('\n').slice(2, 4)).toEqual([
      '2026-11-03 | Planning | Planned.',
      '2026-11-21 | Weekly sync | with [[Mara Quill]] [[Tobias Fenn]] | about [[Larkspur rollout]] | We agreed the cutover date.',
    ]);
    expect(file('_index/meetings/2026-10.md')).toContain(
      '2026-10-02 | Kickoff | with [[Tobias Fenn]] | First look at the plan.\n',
    );
  });

  it('puts a meeting whose file name has no date in undated.md, and gives a misplaced one its path', () => {
    expect(file('_index/meetings/undated.md')).toContain(
      'Meetings/Loose notes.md | with the payroll team | Nothing dated.\n',
    );
    const misplaced = buildAiIndex([{ path: 'Meetings/2026-11-21 Sync.md', text: 'Met.' }]);
    expect(misplaced.find(({ path }) => path === '_index/meetings/2026-11.md')?.text).toContain(
      '2026-11-21 | Sync | Met. | at Meetings/2026-11-21 Sync.md\n',
    );
  });

  it('gives the same bytes for the same notes in any order', () => {
    const shuffled = [...VAULT].reverse();
    shuffled.push(...shuffled.splice(0, 4));
    expect(buildAiIndex(shuffled)).toEqual(files);
  });

  it('writes \\n line endings and one trailing newline, with no timestamps', () => {
    for (const { text } of files) {
      expect(text.endsWith('\n')).toBe(true);
      expect(text.endsWith('\n\n')).toBe(false);
      expect(text).not.toContain('\r');
    }
  });
});
