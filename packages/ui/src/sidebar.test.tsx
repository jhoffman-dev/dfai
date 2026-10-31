// @vitest-environment jsdom
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createVaultPath,
  sidebarEntry,
  sidebarTreeRows,
  type SidebarSectionId,
} from '@dfai/domain';
import { Sidebar, type SidebarQuickView, type SidebarType } from './sidebar.tsx';
import type { SectionStore } from './sidebar-sections.ts';

const fileRows = (...paths: string[]) =>
  sidebarTreeRows(
    paths.map((path) => ({
      entry: { kind: 'file', name: path.split('/').at(-1) ?? '', path: createVaultPath(path) },
      depth: path.split('/').length - 1,
      isExpanded: false,
      isLoaded: true,
    })),
  );

const today: SidebarQuickView = {
  id: 'today',
  entry: sidebarEntry(createVaultPath('.atlas/views/Today.md'), 'list'),
  count: 4,
};

/** A section store that remembers nothing, for the sections' default state. */
const forgetful = (): SectionStore => ({ read: () => null, write: () => {} });

const task: SidebarType = { name: 'task', label: 'Task', count: 62, icon: 'task' };

function show(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const props = {
    favorites: [sidebarEntry(createVaultPath('Acme.md'))],
    types: [task],
    views: [sidebarEntry(createVaultPath('.atlas/views/Board.md'))],
    dashboards: [sidebarEntry(createVaultPath('.atlas/dashboards/Progress.md'))],
    quick: [],
    tree: { rows: fileRows('Acme.md'), onToggleDirectory: () => {} },
    active: null,
    sectionStore: forgetful(),
    onSearch: () => {},
    onOpen: () => {},
    onOpenType: () => {},
    onToggleFavorite: () => {},
    ...overrides,
  };
  return { ...render(<Sidebar {...props} />), props };
}

const heading = (name: string) => screen.getByRole('button', { name });
const region = (name: string) => screen.getByRole('region', { name });

describe('Sidebar', () => {
  it('shows the five sections, in the order the brief sets', () => {
    show();
    expect(screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)).toEqual([
      'Favorites',
      'Types',
      'Views',
      'Dashboards',
      'Pages',
    ]);
  });

  it('opens every section on a first run', () => {
    show();
    for (const label of ['Favorites', 'Types', 'Views', 'Dashboards', 'Pages']) {
      expect(heading(label).getAttribute('aria-expanded')).toBe('true');
    }
  });

  it('collapses a section, and says so', async () => {
    show();
    expect(screen.getByRole('button', { name: 'Board' })).toBeDefined();

    await userEvent.click(heading('Views'));

    expect(heading('Views').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Board' })).toBeNull();
  });

  it('points each heading at the part of the sidebar it opens', () => {
    show();
    const controls = heading('Views').getAttribute('aria-controls');
    expect(controls).not.toBeNull();
    expect(document.getElementById(controls as string)).not.toBeNull();
  });

  it('remembers what was collapsed, and comes back that way', async () => {
    const collapsed: SidebarSectionId[][] = [];
    const store: SectionStore = { read: () => ['types'], write: (ids) => collapsed.push([...ids]) };

    show({ sectionStore: store });

    expect(heading('Types').getAttribute('aria-expanded')).toBe('false');
    expect(heading('Views').getAttribute('aria-expanded')).toBe('true');

    await userEvent.click(heading('Views'));
    expect(collapsed).toEqual([['types', 'views']]);
  });

  it('counts the notes of a type beside it, and says so in words', () => {
    show();
    expect(screen.getByRole('button', { name: 'Task, 62 notes' })).toBeDefined();
    expect(screen.getByText('62')).toBeDefined();
  });

  it('counts one note as a note rather than 1 notes', () => {
    show({ types: [{ name: 'person', label: 'Person', count: 1, icon: 'person' }] });
    expect(screen.getByRole('button', { name: 'Person, 1 note' })).toBeDefined();
  });

  it('keeps a type with no notes listed, with no count drawn for it', () => {
    show({ types: [{ name: 'company', label: 'Company', count: 0, icon: 'company' }, task] });
    const company = screen.getByRole('button', { name: 'Company, 0 notes' });
    expect(company.querySelector('.sidebar__count')).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.getByText('62').classList.contains('sidebar__count')).toBe(true);
  });

  it('draws no count on a quick view that holds nothing', () => {
    show({ quick: [{ ...today, count: 0 }] });
    const row = screen.getByRole('button', { name: 'Today' });
    expect(row.textContent).toBe('Today');
    expect(row.querySelector('.sidebar__badge')).toBeNull();
  });

  it('shows ⌘K on the Search row only to the eye: the row is named Search', () => {
    show();
    const row = screen.getByRole('button', { name: 'Search' });
    const hint = row.querySelector('.sidebar__key');
    expect(hint?.textContent).toBe('⌘K');
    expect(hint?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('button', { name: /⌘K/ })).toBeNull();
  });

  it('offers New type beside the Types heading, leaving the section named Types', async () => {
    const onNewType = vi.fn();
    show({ onNewType });
    const types = region('Types');
    await userEvent.click(within(types).getByRole('button', { name: 'New type' }));
    expect(onNewType).toHaveBeenCalledOnce();
  });

  it('offers no New type when there is nothing to make one with', () => {
    show();
    expect(region('Types')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'New type' })).toBeNull();
  });

  it('lists a type file that cannot be read under Types, with why, and opens the file (#683)', async () => {
    const onOpen = vi.fn();
    const recipe = createVaultPath('.atlas/types/Recipe.md');
    const problem = 'Its frontmatter is not valid YAML: Unexpected end of flow sequence';
    show({ onOpen, brokenTypes: [{ path: recipe, name: 'Recipe', problem }] });
    const types = region('Types');
    // The readable type is still listed beside it.
    expect(within(types).getByRole('button', { name: 'Task, 62 notes' })).toBeDefined();
    const row = within(types).getByRole('button', {
      name: 'Recipe cannot be read: .atlas/types/Recipe.md',
    });
    expect(within(types).getByText(problem)).toBeDefined();
    await userEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith(recipe, 'here');
  });

  it('lists a broken type file even when no type can be read', () => {
    const recipe = createVaultPath('.atlas/types/Recipe.md');
    show({ types: [], brokenTypes: [{ path: recipe, name: 'Recipe', problem: 'Bad YAML' }] });
    expect(within(region('Types')).getByText('Bad YAML')).toBeDefined();
  });

  it('opens the type when its row is clicked', async () => {
    const onOpenType = vi.fn();
    show({ onOpenType });
    await userEvent.click(screen.getByRole('button', { name: 'Task, 62 notes' }));
    expect(onOpenType).toHaveBeenCalledWith('task');
  });

  it('offers Edit type from a type’s menu, by right-click or from the keyboard', async () => {
    const onOpenType = vi.fn();
    const onEditType = vi.fn();
    show({ onOpenType, onEditType });
    const row = screen.getByRole('button', { name: 'Task, 62 notes' });

    await userEvent.pointer({ keys: '[MouseRight]', target: row });
    const menu = within(await screen.findByRole('menu', { name: 'Task' }));
    await userEvent.click(menu.getByRole('menuitem', { name: 'Edit type' }));
    expect(onEditType).toHaveBeenCalledExactlyOnceWith('task');

    row.focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    await userEvent.click(
      within(await screen.findByRole('menu', { name: 'Task' })).getByRole('menuitem', {
        name: 'Open',
      }),
    );
    expect(onOpenType).toHaveBeenCalledExactlyOnceWith('task');
  });

  it('offers Edit template from a type’s menu, beside Edit type (ADR-0026)', async () => {
    const onEditType = vi.fn();
    const onEditTemplate = vi.fn();
    show({ onEditType, onEditTemplate });
    await userEvent.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('button', { name: 'Task, 62 notes' }),
    });
    const menu = within(await screen.findByRole('menu', { name: 'Task' }));
    await userEvent.click(menu.getByRole('menuitem', { name: 'Edit template' }));
    expect(onEditTemplate).toHaveBeenCalledExactlyOnceWith('task');
    expect(onEditType).not.toHaveBeenCalled();
  });

  it('leaves Edit template out of a type’s menu when the app gives no way to it', async () => {
    show({ onEditType: vi.fn() });
    await userEvent.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('button', { name: 'Task, 62 notes' }),
    });
    const menu = within(await screen.findByRole('menu', { name: 'Task' }));
    expect(menu.getByRole('menuitem', { name: 'Edit type' })).toBeTruthy();
    expect(menu.queryByRole('menuitem', { name: 'Edit template' })).toBeNull();
  });

  it('opens the Templates page from its row, marked while it is open', async () => {
    const onOpenTemplates = vi.fn();
    show({ onOpenTemplates, active: { kind: 'templates' } });
    const row = screen.getByRole('button', { name: 'Templates' });
    expect(row.getAttribute('aria-current')).toBe('page');
    await userEvent.click(row);
    expect(onOpenTemplates).toHaveBeenCalledOnce();
  });

  it('opens the Terms page from its row, marked only while it is open (P28-05)', async () => {
    const onOpenTerms = vi.fn();
    const { unmount } = show({ onOpenTerms, active: null });
    expect(screen.getByRole('button', { name: 'Terms' }).getAttribute('aria-current')).toBeNull();
    unmount();
    show({ onOpenTerms, active: { kind: 'terms' } });
    const row = screen.getByRole('button', { name: 'Terms' });
    expect(row.getAttribute('aria-current')).toBe('page');
    await userEvent.click(row);
    expect(onOpenTerms).toHaveBeenCalledOnce();
  });

  it('opens the Skills page from its row, marked only while it is open (#169)', async () => {
    const onOpenSkills = vi.fn();
    const { unmount } = show({ onOpenSkills, active: null });
    expect(screen.getByRole('button', { name: 'Skills' }).getAttribute('aria-current')).toBeNull();
    unmount();
    show({ onOpenSkills, active: { kind: 'skills' } });
    const row = screen.getByRole('button', { name: 'Skills' });
    expect(row.getAttribute('aria-current')).toBe('page');
    await userEvent.click(row);
    expect(onOpenSkills).toHaveBeenCalledOnce();
  });

  it('has no Skills row when nothing opens the page', () => {
    show();
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Skills' })).toBeNull();
  });

  it('has no Terms row when nothing opens the page', () => {
    show();
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Terms' })).toBeNull();
  });

  it('keeps the browser’s own menu on a type when there is nothing to offer', async () => {
    show();
    await userEvent.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('button', { name: 'Task, 62 notes' }),
    });
    expect(screen.queryByRole('menu', { name: 'Task' })).toBeNull();
  });

  it('opens a view by its path', async () => {
    const onOpen = vi.fn();
    show({ onOpen });
    await userEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(onOpen).toHaveBeenCalledWith('.atlas/views/Board.md', 'here');
  });

  it('says what to do with an empty section rather than showing nothing', () => {
    show({ favorites: [], views: [], dashboards: [], types: [] });
    expect(screen.getByText('Star a note to keep it here.')).toBeDefined();
    expect(screen.getByText('No types defined yet.')).toBeDefined();
    expect(screen.getByText('No views yet.')).toBeDefined();
    expect(screen.getByText('No dashboards yet.')).toBeDefined();
  });

  it('shows what is in Pages as a tree, without the extension on a note', () => {
    show();
    expect(screen.getByRole('tree')).toBeDefined();
    expect(within(screen.getByRole('tree')).getByText('Acme')).toBeDefined();
    expect(within(screen.getByRole('tree')).queryByText('Acme.md')).toBeNull();
  });

  it('offers to unfavourite what is already in favourites', () => {
    show();
    expect(
      within(region('Favorites')).getByRole('button', { name: 'Remove Acme from favorites' }),
    ).toBeDefined();
  });

  it('offers to favourite a view that is not one yet', async () => {
    const onToggleFavorite = vi.fn();
    show({ onToggleFavorite });

    await userEvent.click(screen.getByRole('button', { name: 'Add Board to favorites' }));

    expect(onToggleFavorite).toHaveBeenCalledWith('.atlas/views/Board.md');
  });

  it('marks a note in Pages as a favourite when it is one', () => {
    show();
    expect(
      within(screen.getByRole('tree')).getByRole('button', { name: 'Remove Acme from favorites' }),
    ).toBeDefined();
  });

  it('marks the open note, wherever it is listed', () => {
    show({ active: { kind: 'note', path: createVaultPath('.atlas/views/Board.md') } });
    expect(screen.getByRole('button', { name: 'Board' }).getAttribute('aria-current')).toBe('page');
  });

  it('marks only the page it is given, never a second one', () => {
    show({ active: { kind: 'note', path: createVaultPath('.atlas/views/Board.md') } });
    expect(
      within(region('Favorites'))
        .getByRole('button', { name: 'Acme' })
        .getAttribute('aria-current'),
    ).toBeNull();
  });

  it('marks the open type', () => {
    show({ active: { kind: 'type', name: 'task' } });
    expect(
      screen.getByRole('button', { name: 'Task, 62 notes' }).getAttribute('aria-current'),
    ).toBe('page');
  });
});

describe('the Inbox row (P30-01)', () => {
  const inboxView: SidebarQuickView = {
    id: 'inbox',
    entry: sidebarEntry(createVaultPath('.atlas/views/Inbox.md'), 'list'),
    count: 11,
  };
  const goTo = () => within(screen.getByRole('list', { name: 'Go to' }));

  it('opens the Inbox page, after Today, with how many notes wait there', async () => {
    const onOpen = vi.fn();
    const onOpenView = vi.fn();
    show({ quick: [today, inboxView], onOpen: onOpenView, inbox: { onOpen, count: 3 } });

    const names = goTo()
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(names.slice(1, 3)).toEqual(['Today4', 'Inbox3']);

    await userEvent.click(goTo().getByRole('button', { name: /^Inbox/ }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpenView).not.toHaveBeenCalled();
  });

  it('stands in for an Inbox view: there is one Inbox row, not two', () => {
    show({ quick: [today, inboxView], inbox: { onOpen: () => {}, count: 3 } });
    expect(goTo().getAllByRole('button', { name: /^Inbox/ })).toHaveLength(1);
  });

  it('is there in a vault with no Inbox view, and shows no count while none wait', () => {
    show({ quick: [], inbox: { onOpen: () => {}, count: 0 } });
    expect(goTo().getByRole('button', { name: 'Inbox' }).textContent).toBe('Inbox');
  });

  it('is marked while the Inbox page is open', () => {
    show({ inbox: { onOpen: () => {}, count: null }, active: { kind: 'inbox' } });
    expect(goTo().getByRole('button', { name: 'Inbox' }).getAttribute('aria-current')).toBe('page');
  });

  it('leaves an Inbox view as its own row when the app has no Inbox page to offer', async () => {
    const onOpen = vi.fn();
    show({ quick: [inboxView], onOpen });
    await userEvent.click(goTo().getByRole('button', { name: /^Inbox/ }));
    expect(onOpen).toHaveBeenCalledWith('.atlas/views/Inbox.md', 'here');
  });
});

describe('the Today row (#111)', () => {
  const goTo = () => within(screen.getByRole('list', { name: 'Go to' }));
  const todayView: SidebarQuickView = {
    id: 'today',
    entry: sidebarEntry(createVaultPath('.atlas/views/Today.md'), 'list'),
    count: 4,
  };

  it('opens the Today page, first after Search, with no view of that name', async () => {
    const onOpenToday = vi.fn();
    show({ quick: [], inbox: { onOpen: () => {}, count: 2 }, onOpenToday });
    const names = goTo()
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(names.slice(1, 3)).toEqual(['Today', 'Inbox2']);
    await userEvent.click(goTo().getByRole('button', { name: 'Today' }));
    expect(onOpenToday).toHaveBeenCalledOnce();
  });

  it('stands in for a saved view titled Today: one row, and it opens the page', async () => {
    const onOpenToday = vi.fn();
    const onOpen = vi.fn();
    show({ quick: [todayView], onOpenToday, onOpen });
    const rows = goTo().getAllByRole('button', { name: /^Today/ });
    expect(rows).toHaveLength(1);
    await userEvent.click(rows[0] as HTMLElement);
    expect(onOpenToday).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('leaves a Today view its own row while the page is not offered', async () => {
    const onOpen = vi.fn();
    show({ quick: [todayView], onOpen });
    await userEvent.click(goTo().getByRole('button', { name: /^Today/ }));
    expect(onOpen).toHaveBeenCalledWith('.atlas/views/Today.md', 'here');
  });

  it('is marked while the page is open', () => {
    show({ onOpenToday: () => {}, active: { kind: 'today' } });
    expect(goTo().getByRole('button', { name: 'Today' }).getAttribute('aria-current')).toBe('page');
  });
});

describe('the weekly review row (P30-07)', () => {
  const goTo = () => within(screen.getByRole('list', { name: 'Go to' }));

  it('opens the weekly review, under the Inbox', async () => {
    const onOpenReview = vi.fn();
    show({ quick: [], inbox: { onOpen: () => {}, count: 2 }, onOpenReview });
    const names = goTo()
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(names.slice(1, 3)).toEqual(['Inbox2', 'Weekly review']);
    await userEvent.click(goTo().getByRole('button', { name: 'Weekly review' }));
    expect(onOpenReview).toHaveBeenCalledOnce();
  });

  it('is marked while the review is open', () => {
    show({ onOpenReview: () => {}, active: { kind: 'review' } });
    const row = goTo().getByRole('button', { name: 'Weekly review' });
    expect(row.getAttribute('aria-current')).toBe('page');
  });

  it('is absent when the app does not offer it', () => {
    show({});
    expect(goTo().queryByRole('button', { name: 'Weekly review' })).toBeNull();
    expect(goTo().getByRole('button', { name: /Search/ })).toBeDefined();
  });
});

describe('Sidebar quick rows', () => {
  it('opens search from the Search row', async () => {
    const onSearch = vi.fn();
    show({ onSearch });
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('opens a quick view, and shows how many notes it holds', async () => {
    const onOpen = vi.fn();
    show({ quick: [today], onOpen });

    const row = within(screen.getByRole('list', { name: 'Go to' })).getByRole('button', {
      name: /^Today/,
    });
    expect(row.textContent).toContain('4');

    await userEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith('.atlas/views/Today.md', 'here');
  });

  it('shows no count while it is not known', () => {
    show({ quick: [{ ...today, count: null }] });
    const row = within(screen.getByRole('list', { name: 'Go to' })).getByRole('button', {
      name: 'Today',
    });
    expect(row.textContent).toBe('Today');
  });

  it('has no row for a quick view the vault does not have', () => {
    show({ quick: [] });
    const quick = within(screen.getByRole('list', { name: 'Go to' }));
    expect(quick.getByRole('button', { name: 'Search' })).toBeDefined();
    expect(quick.getAllByRole('button')).toHaveLength(1);
  });

  it('marks a quick view that is open', () => {
    show({ quick: [today], active: { kind: 'note', path: today.entry.path } });
    const row = within(screen.getByRole('list', { name: 'Go to' })).getByRole('button', {
      name: /^Today/,
    });
    expect(row.getAttribute('aria-current')).toBe('page');
  });

  it('opens the graph from the row under the quick views', async () => {
    const onOpenGraph = vi.fn();
    show({ quick: [today], onOpenGraph });
    const rows = within(screen.getByRole('list', { name: 'Go to' })).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual(['Search⌘K', 'Today4', 'Graph']);
    expect(rows[2]?.getAttribute('aria-current')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Graph' }));
    expect(onOpenGraph).toHaveBeenCalledTimes(1);
  });

  it('marks the graph while it is open, and nothing else', () => {
    show({ quick: [today], onOpenGraph: () => {}, active: { kind: 'graph' } });
    const quick = within(screen.getByRole('list', { name: 'Go to' }));
    expect(quick.getByRole('button', { name: 'Graph' }).getAttribute('aria-current')).toBe('page');
    expect(quick.getByRole('button', { name: /^Today/ }).getAttribute('aria-current')).toBeNull();
  });

  it('opens the tags from the row under the graph, and marks it while it is open', async () => {
    const onOpenTags = vi.fn();
    show({ quick: [today], onOpenGraph: () => {}, onOpenTags, active: { kind: 'tags' } });
    const quick = within(screen.getByRole('list', { name: 'Go to' }));
    expect(quick.getAllByRole('button').map((row) => row.textContent)).toEqual([
      'Search⌘K',
      'Today4',
      'Graph',
      'Tags',
    ]);
    const row = quick.getByRole('button', { name: 'Tags' });
    expect(row.getAttribute('aria-current')).toBe('page');
    expect(quick.getByRole('button', { name: 'Graph' }).getAttribute('aria-current')).toBeNull();

    await userEvent.click(row);
    expect(onOpenTags).toHaveBeenCalledTimes(1);
  });

  it('opens Activity from the row under Automations, and marks it while it is open', async () => {
    const onOpen = vi.fn();
    show({
      onOpenAutomations: () => {},
      activity: { onOpen, unseenErrors: 0 },
      active: { kind: 'activity' },
    });
    const quick = within(screen.getByRole('list', { name: 'Go to' }));
    expect(quick.getAllByRole('button').map((row) => row.textContent)).toEqual([
      'Search⌘K',
      'Automations',
      'Activity',
    ]);
    const row = quick.getByRole('button', { name: 'Activity' });
    expect(row.getAttribute('aria-current')).toBe('page');
    await userEvent.click(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('badges the Activity row with the errors since it was last open, and says so', () => {
    show({ activity: { onOpen: () => {}, unseenErrors: 3 } });
    const row = screen.getByRole('button', { name: 'Activity, 3 new errors' });
    expect(row?.textContent).toContain('Activity3');
    expect(row.getAttribute('aria-current')).toBeNull();
  });

  it('says one error as one', () => {
    show({ activity: { onOpen: () => {}, unseenErrors: 1 } });
    expect(screen.getByRole('button', { name: 'Activity, 1 new error' })?.textContent).toContain(
      '1',
    );
  });

  it('draws no badge when there is nothing new', () => {
    show({ activity: { onOpen: () => {}, unseenErrors: 0 } });
    const row = screen.getByRole('button', { name: 'Activity' });
    expect(row.textContent).toBe('Activity');
  });
});

describe('Sidebar: the Pages "+"', () => {
  /** The sidebar with the "+" menu's open state held as the app holds it. */
  function WithCreate({ onNote, onFolder }: { onNote: () => void; onFolder: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <Sidebar
        favorites={[]}
        types={[]}
        views={[]}
        dashboards={[]}
        quick={[]}
        tree={{
          rows: fileRows('Acme.md'),
          onToggleDirectory: () => {},
          create: {
            label: 'New in Pages',
            items: [
              { label: 'New note', onSelect: onNote },
              { label: 'New folder', onSelect: onFolder },
            ],
            open,
            onOpenChange: setOpen,
          },
        }}
        active={null}
        sectionStore={forgetful()}
        onSearch={() => {}}
        onOpen={() => {}}
        onOpenType={() => {}}
        onToggleFavorite={() => {}}
      />
    );
  }

  it('offers what can be made at the top of Pages, in the Pages heading', async () => {
    const onNote = vi.fn();
    const onFolder = vi.fn();
    render(<WithCreate onNote={onNote} onFolder={onFolder} />);

    await userEvent.click(within(region('Pages')).getByRole('button', { name: 'New in Pages' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'New folder' }));
    expect(onFolder).toHaveBeenCalledTimes(1);
    expect(onNote).not.toHaveBeenCalled();
  });

  it('has no "+" where nothing can be made', () => {
    show();
    expect(screen.queryByRole('button', { name: 'New in Pages' })).toBeNull();
  });
});

describe('Ask, beside Search (#37)', () => {
  const goTo = () => within(screen.getByRole('list', { name: 'Go to' }));

  it('shares Search’s row, opens Ask, and says ⌘J', async () => {
    const onOpenAsk = vi.fn();
    show({ onOpenAsk });
    const ask = goTo().getByRole('button', { name: 'Ask' });
    expect(ask.closest('li')).toBe(goTo().getByRole('button', { name: 'Search' }).closest('li'));
    expect(ask.getAttribute('title')).toBe('Ask (⌘J)');
    expect(ask.getAttribute('aria-current')).toBeNull();
    await userEvent.click(ask);
    expect(onOpenAsk).toHaveBeenCalledOnce();
  });

  it('is marked while Ask is where you are', () => {
    show({ onOpenAsk: () => {}, active: { kind: 'ask' } });
    expect(goTo().getByRole('button', { name: 'Ask' }).getAttribute('aria-current')).toBe('page');
  });

  it('is not there when the app offers no Ask', () => {
    show();
    expect(goTo().getByRole('button', { name: 'Search' })).toBeDefined();
    expect(goTo().queryByRole('button', { name: 'Ask' })).toBeNull();
  });
});
