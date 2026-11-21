import { noteSummary, VaultIndex } from './index.ts';

const vault = () =>
  VaultIndex.build([
    { path: 'People/Mara Quill.md', text: 'Leads payroll at [[Larkspur Payroll]]. #person' },
    { path: 'Projects/Larkspur Payroll.md', text: 'The rollout. #project/active\n[[Mara Quill]]' },
    {
      path: 'Inbox/Idea.md',
      text: 'Ask [[mara quill|Mara]] about [[Tobias Fenn]]. #idea #Project',
    },
    { path: '_index/README.md', text: '[[Mara Quill]]' },
    { path: '.dfai-lite/favorites.json', text: '[]' },
  ]);

describe('the vault index', () => {
  it('holds only visible notes, sorted', () => {
    expect(vault().paths()).toEqual([
      'Inbox/Idea.md',
      'People/Mara Quill.md',
      'Projects/Larkspur Payroll.md',
    ]);
  });

  it('resolves links out and lists backlinks', () => {
    const index = vault();
    expect(index.outgoing('Inbox/Idea.md').map((link) => link.resolved)).toEqual([
      'People/Mara Quill.md',
      null,
    ]);
    expect(index.backlinks('People/Mara Quill.md')).toEqual([
      'Inbox/Idea.md',
      'Projects/Larkspur Payroll.md',
    ]);
  });

  it('lists unresolved targets with the notes that link them', () => {
    expect(vault().unresolved()).toEqual([
      { key: 'tobias fenn', target: 'Tobias Fenn', sources: ['Inbox/Idea.md'] },
    ]);
  });

  it('indexes tags, nested ones under their parent', () => {
    const index = vault();
    expect(index.notesWithTag('project')).toEqual([
      'Inbox/Idea.md',
      'Projects/Larkspur Payroll.md',
    ]);
    expect(index.notesWithTag('project', { nested: false })).toEqual(['Inbox/Idea.md']);
    expect(index.tagCounts()).toContainEqual({ key: 'project', name: 'Project', count: 1 });
    expect(index.tagTree().map((node) => [node.key, node.total])).toEqual([
      ['idea', 1],
      ['person', 1],
      ['project', 2],
    ]);
  });

  it('updates one note at a time', () => {
    const index = vault();
    index.upsert('Inbox/Idea.md', 'Nothing now.');
    expect(index.backlinks('People/Mara Quill.md')).toEqual(['Projects/Larkspur Payroll.md']);
    expect(index.notesWithTag('idea')).toEqual([]);
    index.upsert('People/Tobias Fenn.md', 'Engineer. [[Mara Quill]]');
    expect(index.unresolved()).toEqual([]);
    index.remove('People/Mara Quill.md');
    expect(index.outgoing('People/Tobias Fenn.md')[0]?.resolved).toBeNull();
  });

  it('follows a rename: links by the old name stop resolving, its own links go with it', () => {
    const index = vault();
    index.rename('People/Mara Quill.md', 'People/Mara Q.md');
    expect(index.resolve('Mara Quill')).toBeNull();
    expect(index.backlinks('Projects/Larkspur Payroll.md')).toEqual(['People/Mara Q.md']);
    expect(index.tagsOf('People/Mara Q.md')).toEqual([{ key: 'person', name: 'person' }]);
  });

  it('draws the graph with ghost nodes for unresolved targets, deterministically', () => {
    const graph = vault().graph();
    expect(graph.nodes.map((node) => node.id)).toEqual([
      'Inbox/Idea.md',
      'People/Mara Quill.md',
      'Projects/Larkspur Payroll.md',
      'ghost:tobias fenn',
    ]);
    expect(graph.edges).toEqual([
      { source: 'Inbox/Idea.md', target: 'People/Mara Quill.md' },
      { source: 'Inbox/Idea.md', target: 'ghost:tobias fenn' },
      { source: 'People/Mara Quill.md', target: 'Projects/Larkspur Payroll.md' },
      { source: 'Projects/Larkspur Payroll.md', target: 'People/Mara Quill.md' },
    ]);
  });
});

describe('a note’s summary', () => {
  it('is the first sentence of the first prose line, markup off', () => {
    const text = '# Title\n\n- Met **[[Mara Quill|Mara]]** about `pay`. Then more.';
    expect(noteSummary(text)).toBe('Met Mara about pay.');
    expect(noteSummary('```\ncode.\n```\n#tag only')).toBe('#tag only');
    expect(noteSummary('')).toBe('');
  });

  it('cuts a long sentence with an ellipsis', () => {
    expect(noteSummary('a'.repeat(300))).toHaveLength(200);
  });
});
