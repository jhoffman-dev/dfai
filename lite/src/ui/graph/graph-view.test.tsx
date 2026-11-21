import { fireEvent, render, screen } from '@testing-library/react';
import type { GraphNode, VaultGraph } from '../../domain/index/index.ts';
import { GraphView } from './index.ts';

const note = (id: string): GraphNode => ({
  id,
  kind: 'note',
  title: id.replace(/^.*\//, '').replace(/\.md$/, ''),
});

/** As `VaultIndex.graph()` gives it; the UI may use domain types only, so it is written out. */
const graph: VaultGraph = {
  nodes: [
    note('Inbox/Far away.md'),
    note('Inbox/Loose idea.md'),
    note('People/Mara Quill.md'),
    note('People/Tobias Fenn.md'),
    note('Projects/Larkspur rollout.md'),
    { id: 'ghost:larkspur payroll', kind: 'ghost', title: 'Larkspur Payroll' },
  ],
  edges: [
    { source: 'Inbox/Far away.md', target: 'People/Tobias Fenn.md' },
    { source: 'People/Mara Quill.md', target: 'Projects/Larkspur rollout.md' },
    { source: 'People/Tobias Fenn.md', target: 'People/Mara Quill.md' },
    { source: 'Projects/Larkspur rollout.md', target: 'ghost:larkspur payroll' },
  ],
};

const nodes = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-node]')].map(
    (node) => node.getAttribute('data-node') ?? '',
  );

function setup(activePath: string | null = 'Projects/Larkspur rollout.md') {
  const onOpenNote = vi.fn();
  const view = render(<GraphView graph={graph} activePath={activePath} onOpenNote={onOpenNote} />);
  return { ...view, onOpenNote };
}

describe('GraphView', () => {
  it('draws a node per note, and a ghost for a link target with no note', () => {
    const { container } = setup();
    expect(nodes(container)).toHaveLength(6);
    expect(container.querySelectorAll('.graph__node--ghost')).toHaveLength(1);
    expect(container.querySelector('.graph__node--active')?.getAttribute('data-node')).toBe(
      'Projects/Larkspur rollout.md',
    );
  });

  it('opens a note when its node is clicked', () => {
    const { container, onOpenNote } = setup();
    const node = container.querySelector('[data-node="People/Mara Quill.md"]') as Element;
    fireEvent.pointerDown(node, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(container.querySelector('svg') as Element, { clientX: 10, clientY: 10 });
    expect(onOpenNote).toHaveBeenCalledWith('People/Mara Quill.md');
  });

  it('limits the local graph to the open note and its neighbours, one or two steps out', () => {
    const { container } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Local graph' }));
    expect(nodes(container).sort()).toEqual([
      'People/Mara Quill.md',
      'Projects/Larkspur rollout.md',
      'ghost:larkspur payroll',
    ]);
    fireEvent.change(screen.getByLabelText('Depth'), { target: { value: '2' } });
    expect(nodes(container)).toContain('People/Tobias Fenn.md');
    expect(nodes(container)).not.toContain('Inbox/Far away.md');
  });

  it('cannot go local with no note open', () => {
    setup(null);
    expect(screen.getByRole('button', { name: 'Local graph' })).toBeDisabled();
  });

  it('narrows to the notes the filter matches', () => {
    const { container } = setup();
    fireEvent.change(screen.getByLabelText('Filter notes'), { target: { value: 'people/' } });
    expect(nodes(container).sort()).toEqual(['People/Mara Quill.md', 'People/Tobias Fenn.md']);
  });

  it('lists the same notes as buttons for the keyboard', () => {
    const { onOpenNote } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    const list = screen.getByRole('list', { name: 'Notes in the graph' });
    expect(list.querySelectorAll(':scope > li')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Loose idea' }));
    expect(onOpenNote).toHaveBeenCalledWith('Inbox/Loose idea.md');
  });

  it('draws only the most linked notes past the cap, and says so', () => {
    const ids = Array.from({ length: 650 }, (_, at) => `N${at}.md`);
    const many: VaultGraph = {
      nodes: ids.map(note),
      edges: ids.slice(1).map((source) => ({ source, target: 'N0.md' })),
    };
    render(<GraphView graph={many} activePath={null} onOpenNote={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Showing the 600 most linked notes; 50 more',
    );
  });
});
