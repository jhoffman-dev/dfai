import { createMiniSearchEngine } from './index.ts';

const PLAN = 'Projects/Larkspur Payroll.md';
const MARA = 'People/Mara Quill.md';
const SHED = 'Projects/Garden shed.md';

function engine() {
  const search = createMiniSearchEngine();
  search.index([
    { path: PLAN, text: 'Moving Larkspur onto the new payroll system by the end of the quarter.' },
    { path: MARA, text: 'Mara leads payroll operations and prefers written updates.' },
    { path: SHED, text: 'Building a shed at the bottom of the garden.' },
  ]);
  return search;
}

const paths = (hits: readonly { path: string }[]) => hits.map((hit) => hit.path);

describe('the MiniSearch engine', () => {
  it('finds notes by their text, with a snippet around the hit', () => {
    const [hit] = engine().search('written');
    expect(hit).toEqual({
      path: MARA,
      title: 'Mara Quill',
      snippet: '…leads payroll operations and prefers written updates.',
    });
  });

  it('ranks a title match above a body match', () => {
    expect(paths(engine().search('payroll'))[0]).toBe(PLAN);
  });

  it('matches a prefix and a near miss', () => {
    expect(paths(engine().search('gard'))).toEqual([SHED]);
    expect(paths(engine().search('opertions'))).toEqual([MARA]);
  });

  it('returns nothing for a blank query and honours the limit', () => {
    const search = engine();
    expect(search.search('   ')).toEqual([]);
    expect(search.search('payroll', { limit: 1 })).toHaveLength(1);
  });

  it('re-reads a note on update and adds one it has not seen', () => {
    const search = engine();
    search.update(SHED, 'Now about a greenhouse instead.');
    search.update('Inbox/Untitled.md', 'A greenhouse budget.');
    expect(paths(search.search('shed'))).toEqual([SHED]); // the title still says shed
    expect(paths(search.search('bottom'))).toEqual([]);
    expect(paths(search.search('greenhouse')).sort()).toEqual(['Inbox/Untitled.md', SHED]);
  });

  it('forgets a removed note, and removing an unknown one is harmless', () => {
    const search = engine();
    search.remove(MARA);
    search.remove('Nowhere.md');
    expect(paths(search.search('written'))).toEqual([]);
  });

  it('starts over on index', () => {
    const search = engine();
    search.index([{ path: 'Welcome.md', text: 'Hello' }]);
    expect(paths(search.search('payroll'))).toEqual([]);
    expect(paths(search.search('hello'))).toEqual(['Welcome.md']);
  });

  it('marks a snippet cut from a longer text', () => {
    const search = createMiniSearchEngine();
    search.index([
      { path: 'Long.md', text: `${'filler '.repeat(20)}needle ${'tail '.repeat(30)}` },
    ]);
    const [hit] = search.search('needle');
    expect(hit?.snippet).toMatch(/^….*needle.*…$/);
  });
});
