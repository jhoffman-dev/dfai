import { describe, expect, it } from 'vitest';
import {
  canMoveSection,
  movedSection,
  parseSectionOrder,
  placeInOrder,
  sectionOrder,
  shownSections,
} from './section-order.ts';
import type { SidebarSectionId } from './sidebar-section.ts';

const DEFAULT: readonly SidebarSectionId[] = [
  'favorites',
  'types',
  'views',
  'dashboards',
  'userSpace',
];

describe('parseSectionOrder', () => {
  it('is null when the settings say nothing, which is not the same as an empty list', () => {
    expect(parseSectionOrder(undefined)).toBeNull();
    expect(parseSectionOrder(null)).toBeNull();
    expect(parseSectionOrder([])).toEqual([]);
  });

  it('keeps the sections it knows, in the order written', () => {
    expect(parseSectionOrder(['views', 'favorites'])).toEqual(['views', 'favorites']);
  });

  it('ignores an id that names no section, and lists a section once', () => {
    expect(parseSectionOrder(['inbox', 'views', 7, 'views', null, 'types'])).toEqual([
      'views',
      'types',
    ]);
  });

  it('reads a lone name, as a hand-edited file might hold, as a list of one', () => {
    expect(parseSectionOrder('dashboards')).toEqual(['dashboards']);
    expect(parseSectionOrder({ views: 1 })).toEqual([]);
  });
});

describe('sectionOrder', () => {
  it('is the default order when nothing was chosen', () => {
    expect(sectionOrder(null)).toEqual(DEFAULT);
    expect(sectionOrder([])).toEqual(DEFAULT);
  });

  it('puts the chosen sections first, in the chosen order', () => {
    expect(sectionOrder(['userSpace', 'views', 'favorites', 'dashboards', 'types'])).toEqual([
      'userSpace',
      'views',
      'favorites',
      'dashboards',
      'types',
    ]);
  });

  it('appends a section the saved order does not name, in the default order', () => {
    // A section added in a later version arrives at the end rather than hidden.
    expect(sectionOrder(['dashboards', 'favorites'])).toEqual([
      'dashboards',
      'favorites',
      'types',
      'views',
      'userSpace',
    ]);
  });

  it('names every section exactly once, whatever it is given', () => {
    const order = sectionOrder(['views', 'views', 'types']);
    expect([...order].sort()).toEqual([...DEFAULT].sort());
  });
});

describe('movedSection', () => {
  it('moves a section up, onto the place of the one it lands on', () => {
    expect(movedSection({ order: DEFAULT, id: 'dashboards', to: 0 })).toEqual([
      'dashboards',
      'favorites',
      'types',
      'views',
      'userSpace',
    ]);
  });

  it('moves a section down, to just after the one it lands on', () => {
    expect(movedSection({ order: DEFAULT, id: 'favorites', to: 2 })).toEqual([
      'types',
      'views',
      'favorites',
      'dashboards',
      'userSpace',
    ]);
  });

  it('moves one place at a time, as the keyboard does', () => {
    const down = movedSection({ order: DEFAULT, id: 'types', to: 2 });
    expect(down).toEqual(['favorites', 'views', 'types', 'dashboards', 'userSpace']);
    const up = movedSection({ order: down, id: 'types', to: 1 });
    expect(up).toEqual(DEFAULT);
  });

  it('clamps a place past either end', () => {
    expect(movedSection({ order: DEFAULT, id: 'views', to: 99 }).at(-1)).toBe('views');
    expect(movedSection({ order: DEFAULT, id: 'views', to: -3 })[0]).toBe('views');
  });

  it('leaves the order alone for a move to where it already is', () => {
    expect(movedSection({ order: DEFAULT, id: 'views', to: 2 })).toEqual(DEFAULT);
  });

  it('fills in sections an old saved order does not name before moving', () => {
    expect(movedSection({ order: ['views'], id: 'userSpace', to: 0 })).toEqual([
      'userSpace',
      'views',
      'favorites',
      'types',
      'dashboards',
    ]);
  });
});

describe('canMoveSection', () => {
  it('lets a move to another place through, and says a move to the same place is none', () => {
    expect(canMoveSection({ order: DEFAULT, id: 'userSpace', to: 2 })).toBe(true);
    expect(canMoveSection({ order: DEFAULT, id: 'userSpace', to: 4 })).toBe(false);
    expect(canMoveSection({ order: DEFAULT, id: 'favorites', to: -1 })).toBe(false);
    expect(canMoveSection({ order: DEFAULT, id: 'userSpace', to: 5 })).toBe(false);
  });

  it('moves a section past any other, with no regard to which are open or shut', () => {
    // Since issue #17 every section scrolls together, so a shut one is not
    // gathered at the bottom: the order is the order, open or shut (ADR-0013).
    expect(canMoveSection({ order: DEFAULT, id: 'dashboards', to: 4 })).toBe(true);
    expect(movedSection({ order: DEFAULT, id: 'dashboards', to: 4 })).toEqual([
      'favorites',
      'types',
      'views',
      'userSpace',
      'dashboards',
    ]);
  });
});

describe('shownSections', () => {
  it('is every section in its order when none is hidden', () => {
    expect(shownSections({ order: null, hidden: [] })).toEqual(DEFAULT);
  });

  it('leaves the hidden ones out and keeps the rest where they were', () => {
    const order: SidebarSectionId[] = ['userSpace', 'views', 'favorites', 'types', 'dashboards'];
    expect(shownSections({ order, hidden: ['userSpace', 'types'] })).toEqual([
      'views',
      'favorites',
      'dashboards',
    ]);
  });
});

describe('placeInOrder', () => {
  // Pages moved up between Favorites and Types, then hidden.
  const order: SidebarSectionId[] = ['favorites', 'userSpace', 'types', 'views', 'dashboards'];
  const shown = shownSections({ order, hidden: ['userSpace'] });

  it('is the same place when nothing is hidden', () => {
    expect(
      [0, 1, 2, 3, 4].map((to) => placeInOrder({ order: DEFAULT, shown: DEFAULT, to })),
    ).toEqual([0, 1, 2, 3, 4]);
  });

  it('is the place of the shown section it was dropped on', () => {
    expect(placeInOrder({ order, shown, to: 1 })).toBe(2);
    expect(placeInOrder({ order, shown, to: 0 })).toBe(0);
    expect(placeInOrder({ order, shown, to: 3 })).toBe(4);
  });

  it('clamps a place past either end to the first or last shown section', () => {
    expect(placeInOrder({ order, shown, to: -3 })).toBe(0);
    expect(placeInOrder({ order, shown, to: 9 })).toBe(4);
  });

  it('moves a section among the shown ones exactly where it was dropped, past the hidden one', () => {
    const up = movedSection({ order, id: 'dashboards', to: placeInOrder({ order, shown, to: 1 }) });
    expect(shownSections({ order: up, hidden: ['userSpace'] })).toEqual([
      'favorites',
      'dashboards',
      'types',
      'views',
    ]);
    const down = movedSection({
      order,
      id: 'favorites',
      to: placeInOrder({ order, shown, to: 1 }),
    });
    expect(shownSections({ order: down, hidden: ['userSpace'] })).toEqual([
      'types',
      'favorites',
      'views',
      'dashboards',
    ]);
  });

  it('keeps the hidden section in the order a move writes', () => {
    const moved = movedSection({ order, id: 'views', to: placeInOrder({ order, shown, to: 0 }) });
    expect(moved).toHaveLength(5);
    expect(moved).toContain('userSpace');
  });
});
