import {
  createWikiLinkResolver,
  formatWikiLink,
  linkMatchOf,
  moveResolvers,
  noteFromLink,
  notesAfterMove,
  openLinkInText,
  rankNoteSuggestions,
  resolveWikiLinkTarget,
  retargetLinks,
  splitWikiLinks,
  wikiLinkSpans,
} from './index.ts';

const targets = (text: string) => wikiLinkSpans(text).map(({ link }) => link.target);

describe('the link grammar', () => {
  it('reads a plain link, an alias and a heading', () => {
    const [plain, aliased, headed] = wikiLinkSpans('[[A]] [[B|shown]] [[C#Plan]]').map(
      ({ link }) => link,
    );
    expect(plain).toMatchObject({ target: 'A', heading: null, alias: null });
    expect(aliased).toMatchObject({ target: 'B', alias: 'shown' });
    expect(headed).toMatchObject({ target: 'C', heading: '#Plan' });
  });

  it('skips links in code spans and fenced code', () => {
    expect(targets('`[[no]]` and\n\n```\n[[none]]\n```\n[[yes]]')).toEqual(['yes']);
  });

  it('skips an escaped link, one across a line, and the empty link', () => {
    expect(targets('\\[[no]] [[bro\nken]] [[]]')).toEqual([]);
  });

  it('records where the target is, for a rename to rewrite', () => {
    const [span] = wikiLinkSpans('see [[Mara Quill|Mara]]');
    expect(span).toMatchObject({ targetStart: 6, targetEnd: 16 });
  });

  it('splits text into pieces and writes a link back as read', () => {
    const pieces = splitWikiLinks('Met [[Mara Quill|Mara]] today');
    expect(pieces.map((piece) => piece.kind)).toEqual(['text', 'wikiLink', 'text']);
    const link = pieces[1];
    if (link?.kind !== 'wikiLink') throw new Error('expected a link');
    expect(formatWikiLink(link)).toBe('[[Mara Quill|Mara]]');
  });
});

describe('resolving a link', () => {
  const notes = ['People/Mara Quill.md', 'Archive/People/Mara Quill.md', 'Projects/Plan.md'];

  it('finds a bare name anywhere, the shallowest first', () => {
    expect(resolveWikiLinkTarget('Mara Quill', notes)).toBe('People/Mara Quill.md');
  });

  it('reads a target with a slash as a path from the root', () => {
    expect(resolveWikiLinkTarget('Archive/People/Mara Quill', notes)).toBe(
      'Archive/People/Mara Quill.md',
    );
    expect(resolveWikiLinkTarget('People/Plan', notes)).toBeNull();
  });

  it('ignores case and how accents are encoded, but prefers an exact spelling', () => {
    expect(resolveWikiLinkTarget('mara quill', notes)).toBe('People/Mara Quill.md');
    const accents = ['Zoë.md', 'Deep/Zoë.md'];
    expect(resolveWikiLinkTarget('Zoë', accents)).toBe('Zoë.md');
    expect(resolveWikiLinkTarget('plan', ['plan.md', 'Plan.md'])).toBe('plan.md');
  });

  it('breaks a tie by path, and the resolver agrees with the plain search', () => {
    const tied = ['B/Note.md', 'A/Note.md'];
    expect(resolveWikiLinkTarget('Note', tied)).toBe('A/Note.md');
    expect(createWikiLinkResolver(tied)('note.md')).toBe('A/Note.md');
    expect(createWikiLinkResolver(tied)('  ')).toBeNull();
  });
});

describe('a note made from a link', () => {
  const resolve = createWikiLinkResolver(['People/Mara Quill.md']);

  it('puts a bare name in the Inbox', () => {
    expect(noteFromLink('Larkspur rollout', resolve)).toEqual({
      kind: 'create',
      path: 'Inbox/Larkspur rollout.md',
      linkTarget: 'Larkspur rollout',
    });
  });

  it('puts a path where it says, cleaning each part', () => {
    expect(noteFromLink('Projects/Q3: plan', resolve)).toMatchObject({
      path: 'Projects/Q3 plan.md',
      linkTarget: 'Projects/Q3 plan',
    });
  });

  it('opens the note that already answers instead of making a second', () => {
    expect(noteFromLink('mara quill', resolve)).toEqual({
      kind: 'existing',
      path: 'People/Mara Quill.md',
    });
  });

  it('refuses nothing, link syntax, and a name with nothing usable', () => {
    expect(noteFromLink('  ', resolve).kind).toBe('refused');
    expect(noteFromLink('A#b', resolve).kind).toBe('refused');
    expect(noteFromLink('Projects/...', resolve).kind).toBe('refused');
  });
});

describe('retargeting links across a move', () => {
  const notes = ['People/Mara Quill.md', 'Inbox/Plan.md', 'Projects/Plan.md'];
  const across = (from: string, to: string) => moveResolvers(notesAfterMove({ from, to }, notes));

  it('renames the target and keeps alias and heading byte for byte', () => {
    const result = retargetLinks(
      'see [[Mara Quill#Role|Mara]] and ![[Mara Quill]]',
      across('People/Mara Quill.md', 'People/Mara Q.md'),
    );
    expect(result).toEqual({ text: 'see [[Mara Q#Role|Mara]] and ![[Mara Q]]', count: 2 });
  });

  it('rewrites a link written as a path when its folder moves', () => {
    const result = retargetLinks('[[People/Mara Quill]]', across('People', 'Contacts'));
    expect(result.text).toBe('[[Contacts/Mara Quill]]');
  });

  it('writes a path when a moved note would take the bare name of another', () => {
    // [[Plan]] opens Inbox/Plan.md; moving Projects/Plan.md to the root takes the name.
    const result = retargetLinks('[[Plan]]', across('Projects/Plan.md', 'Plan.md'));
    expect(result.text).toBe('[[Inbox/Plan]]');
  });

  it('leaves alone links that still open their note, unresolved ones, and code', () => {
    const text = '[[Plan]] [[Nobody]] `[[Mara Quill]]`';
    expect(retargetLinks(text, across('People/Mara Quill.md', 'Mara Quill.md'))).toEqual({
      text,
      count: 0,
    });
  });
});

describe('link suggestions', () => {
  const notes = ['Larkspur Payroll.md', 'Projects/Larkspur.md', 'People/Mara Quill.md'];
  const resolve = createWikiLinkResolver(notes);

  it('grades how a query meets a name', () => {
    expect(linkMatchOf('Larkspur Payroll', 'larkspur payroll')).toBe('exact');
    expect(linkMatchOf('Larkspur Payroll', 'lark')).toBe('prefix');
    expect(linkMatchOf('Larkspur Payroll', 'pay')).toBe('word');
    expect(linkMatchOf('Larkspur Payroll', 'spur')).toBe('contains');
    expect(linkMatchOf('Larkspur Payroll', 'lkpr')).toBe('fuzzy');
    expect(linkMatchOf('Larkspur Payroll', 'lk')).toBeNull();
    expect(linkMatchOf('Zoë', 'zoe')).toBe('exact');
  });

  it('ranks by match, then shorter name, and gives the target to write', () => {
    const ranked = rankNoteSuggestions({ query: 'lark', notes, resolve });
    expect(ranked.map((note) => note.path)).toEqual([
      'Projects/Larkspur.md',
      'Larkspur Payroll.md',
    ]);
    expect(ranked[0]?.target).toBe('Larkspur');
  });

  it('finds the half-typed link at the caret', () => {
    expect(openLinkInText('see [[Mar', 9)).toEqual({ start: 4, query: 'Mar' });
    expect(openLinkInText('see [[Mara]] x', 14)).toBeNull();
  });
});
