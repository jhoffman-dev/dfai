// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, sidebarEntry, type SidebarSectionId } from '@dfai/domain';
import { Sidebar } from './sidebar.tsx';
import type { SectionStore } from './sidebar-sections.ts';

// P19-01 and P19-02: the sections can be put in any order. Since issue #17 a
// shut section keeps its place rather than sliding below the open ones
// (ADR-0013, addendum).

const forgetful = (): SectionStore => ({ read: () => null, write: () => {} });

/** The sidebar with its order held as the app holds it, and every change recorded. */
function Ordered({
  saved = null,
  changes,
  sectionStore = forgetful(),
  movable = true,
  hidden = [],
}: {
  saved?: readonly SidebarSectionId[] | null;
  changes: SidebarSectionId[][];
  sectionStore?: SectionStore;
  movable?: boolean;
  hidden?: readonly SidebarSectionId[];
}) {
  const [order, setOrder] = useState(saved);
  const onChange = (next: readonly SidebarSectionId[]) => {
    changes.push([...next]);
    setOrder(next);
  };
  return (
    <Sidebar
      favorites={[]}
      types={[{ name: 'task', label: 'Task', count: 2, icon: 'task' }]}
      views={[sidebarEntry(createVaultPath('.atlas/views/Board.md'))]}
      dashboards={[]}
      quick={[]}
      tree={{ rows: [], onToggleDirectory: () => {} }}
      active={null}
      sectionStore={sectionStore}
      sectionOrder={movable ? { saved: order, onChange } : { saved: order }}
      hiddenSections={hidden}
      onSearch={() => {}}
      onOpen={() => {}}
      onOpenType={() => {}}
      onToggleFavorite={() => {}}
    />
  );
}

const headings = () => screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
const heading = (name: string) => screen.getByRole('button', { name });
const grip = (name: string) => screen.getByRole('button', { name: `Move ${name}` });

describe('Sidebar section order', () => {
  it('shows the sections in the order the vault keeps', () => {
    render(<Ordered saved={['userSpace', 'views']} changes={[]} />);
    expect(headings()).toEqual(['Pages', 'Views', 'Favorites', 'Types', 'Dashboards']);
  });

  it('moves a section down one place with Alt+↓ on its grip, and says so', async () => {
    const changes: SidebarSectionId[][] = [];
    render(<Ordered changes={changes} />);

    grip('Favorites').focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(changes).toEqual([['types', 'favorites', 'views', 'dashboards', 'userSpace']]);
    expect(headings()).toEqual(['Types', 'Favorites', 'Views', 'Dashboards', 'Pages']);
  });

  it('keeps focus on the grip that moved, so a second press moves it again', async () => {
    const changes: SidebarSectionId[][] = [];
    render(<Ordered changes={changes} />);

    grip('Favorites').focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(document.activeElement).toBe(grip('Favorites'));
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(headings()).toEqual(['Types', 'Views', 'Favorites', 'Dashboards', 'Pages']);
  });

  it('moves a section up with Alt+↑, and not past the top', async () => {
    const changes: SidebarSectionId[][] = [];
    render(<Ordered changes={changes} />);

    grip('Types').focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');

    expect(headings()).toEqual(['Types', 'Favorites', 'Views', 'Dashboards', 'Pages']);
    expect(changes).toHaveLength(1);
  });

  it('moves a shut section past an open one, and an open one past it, like any other', async () => {
    const changes: SidebarSectionId[][] = [];
    const typesShut: SectionStore = { read: () => ['types'], write: () => {} };
    render(<Ordered changes={changes} sectionStore={typesShut} />);
    expect(headings()).toEqual(['Favorites', 'Types', 'Views', 'Dashboards', 'Pages']);

    grip('Types').focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    grip('Favorites').focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');

    expect(headings()).toEqual(['Favorites', 'Types', 'Views', 'Dashboards', 'Pages']);
    expect(changes).toEqual([
      ['types', 'favorites', 'views', 'dashboards', 'userSpace'],
      ['favorites', 'types', 'views', 'dashboards', 'userSpace'],
    ]);
  });

  it('stops Alt+↓ on the last section, shut or not, and saves nothing', async () => {
    const changes: SidebarSectionId[][] = [];
    const pagesShut: SectionStore = { read: () => ['userSpace'], write: () => {} };
    render(<Ordered changes={changes} sectionStore={pagesShut} />);

    grip('Pages').focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(headings()).toEqual(['Favorites', 'Types', 'Views', 'Dashboards', 'Pages']);
    expect(changes).toEqual([]);
  });

  it('offers no grip when the order cannot be changed', () => {
    render(<Ordered changes={[]} movable={false} />);
    expect(heading('Types')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Move Types' })).toBeNull();
  });
});

describe('Sidebar, collapsing', () => {
  it('keeps a section in its place when it shuts, and when it opens again', async () => {
    render(<Ordered changes={[]} />);

    await userEvent.click(heading('Types'));
    expect(heading('Types').getAttribute('aria-expanded')).toBe('false');
    expect(headings()).toEqual(['Favorites', 'Types', 'Views', 'Dashboards', 'Pages']);

    await userEvent.click(heading('Types'));
    expect(heading('Types').getAttribute('aria-expanded')).toBe('true');
    expect(headings()).toEqual(['Favorites', 'Types', 'Views', 'Dashboards', 'Pages']);
  });

  it('keeps shut sections in the chosen order among the open ones', async () => {
    render(<Ordered saved={['userSpace', 'dashboards']} changes={[]} />);

    await userEvent.click(heading('Favorites'));
    await userEvent.click(heading('Pages'));

    expect(headings()).toEqual(['Pages', 'Dashboards', 'Favorites', 'Types', 'Views']);
  });

  it('comes back with what was shut still in its place', () => {
    render(<Ordered changes={[]} sectionStore={{ read: () => ['favorites'], write: () => {} }} />);
    expect(headings()).toEqual(['Favorites', 'Types', 'Views', 'Dashboards', 'Pages']);
    expect(heading('Favorites').getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps focus on the heading that was pressed', async () => {
    render(<Ordered changes={[]} />);
    heading('Favorites').focus();
    await userEvent.keyboard('{Enter}');

    expect(heading('Favorites').getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(heading('Favorites'));
  });

  it('scrolls every section, the tree too, in the one scroller (issue #17)', () => {
    const { container } = render(<Ordered changes={[]} />);
    const scrollers = container.querySelectorAll('.sidebar__scroll');
    expect(scrollers).toHaveLength(1);
    const pages = screen.getByRole('region', { name: 'Pages' });
    const tree = pages.querySelector('.tree');
    expect(tree).not.toBeNull();
    // The tree borrows the sidebar's scroller rather than bringing its own.
    expect(tree?.classList.contains('tree--shared')).toBe(true);
    for (const name of ['Favorites', 'Types', 'Views', 'Dashboards', 'Pages']) {
      expect(scrollers[0]?.contains(screen.getByRole('region', { name }))).toBe(true);
    }
  });
});

describe('Sidebar, the slide', () => {
  const animate = vi.fn();
  const { animate: realAnimate } = HTMLElement.prototype;
  const realMatchMedia = window.matchMedia;

  /** Stands in for layout: each section's top is where it sits in the list. */
  function withLayout({ reduced }: { reduced: boolean }) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const at = [...document.querySelectorAll('[data-reorder-id]')].indexOf(this);
      return { top: at * 40 } as DOMRect;
    });
    HTMLElement.prototype.animate = animate;
    window.matchMedia = ((query: string) => ({
      matches: reduced && query.includes('reduce'),
    })) as typeof window.matchMedia;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    animate.mockReset();
    HTMLElement.prototype.animate = realAnimate;
    window.matchMedia = realMatchMedia;
  });

  it('slides each section that moved from where it was', async () => {
    withLayout({ reduced: false });
    render(<Ordered changes={[]} />);

    grip('Types').focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');

    // Types went from second to third: it starts a row (40px) up, Views a row down.
    const moved = animate.mock.contexts.map((node) => (node as HTMLElement).dataset.reorderId);
    expect([...moved].sort()).toEqual(['types', 'views']);
    const types = animate.mock.calls[moved.indexOf('types')]?.[0] as Keyframe[];
    expect(types[0]).toEqual({ transform: 'translateY(-40px)' });
  });

  it('does not slide when the viewer asks for reduced motion', async () => {
    withLayout({ reduced: true });
    render(<Ordered changes={[]} />);

    grip('Types').focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(headings()[2]).toBe('Types');
    expect(animate).not.toHaveBeenCalled();
  });

  describe('with Pages hidden (#902)', () => {
    const pagesUpTop: SidebarSectionId[] = [
      'favorites',
      'userSpace',
      'types',
      'views',
      'dashboards',
    ];

    it('moves a section among the shown ones exactly where it went, Pages keeping its place', async () => {
      const changes: SidebarSectionId[][] = [];
      render(<Ordered saved={pagesUpTop} changes={changes} hidden={['userSpace']} />);

      grip('Favorites').focus();
      await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');

      expect(headings()).toEqual(['Types', 'Favorites', 'Views', 'Dashboards']);
      expect(changes).toEqual([['userSpace', 'types', 'favorites', 'views', 'dashboards']]);
    });

    it('stops Alt+↓ on the last shown section, though a hidden one may follow it', async () => {
      const changes: SidebarSectionId[][] = [];
      render(<Ordered changes={changes} hidden={['userSpace']} />);

      grip('Dashboards').focus();
      await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');

      expect(headings()).toEqual(['Favorites', 'Types', 'Views', 'Dashboards']);
      expect(changes).toEqual([]);
    });
  });
});
