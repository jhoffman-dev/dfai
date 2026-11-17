import { describe, expect, it } from 'vitest';
import {
  isSidebarSectionId,
  parseCollapsedSections,
  parseHiddenSections,
  SIDEBAR_SECTIONS,
  withSectionShown,
} from './sidebar-section.ts';

describe('SIDEBAR_SECTIONS', () => {
  it('is the five peers, in the order the brief sets', () => {
    expect(SIDEBAR_SECTIONS.map((section) => section.id)).toEqual([
      'favorites',
      'types',
      'views',
      'dashboards',
      'userSpace',
    ]);
  });

  it('names every section', () => {
    for (const section of SIDEBAR_SECTIONS) expect(section.label).not.toBe('');
  });
});

describe('isSidebarSectionId', () => {
  it('accepts a section that exists', () => {
    expect(isSidebarSectionId('views')).toBe(true);
  });

  it.each([['inbox'], [''], [null], [7], [{ id: 'views' }]])('refuses %j', (value) => {
    expect(isSidebarSectionId(value)).toBe(false);
  });
});

describe('parseCollapsedSections', () => {
  it('keeps the sections that exist', () => {
    expect(parseCollapsedSections(['types', 'views'])).toEqual(['types', 'views']);
  });

  it('drops anything it does not recognise', () => {
    expect(parseCollapsedSections(['types', 'inbox', null, 3])).toEqual(['types']);
  });

  it('lists a section once', () => {
    expect(parseCollapsedSections(['types', 'types'])).toEqual(['types']);
  });

  it.each([[null], [undefined], ['types'], [{}]])(
    'collapses nothing when what was remembered is %j',
    (remembered) => {
      expect(parseCollapsedSections(remembered)).toEqual([]);
    },
  );
});

describe('parseHiddenSections', () => {
  it('hides Pages when nothing has been remembered', () => {
    expect(parseHiddenSections(undefined)).toEqual(['userSpace']);
    expect(parseHiddenSections(null)).toEqual(['userSpace']);
  });

  it('hides nothing when the remembered list is empty: Pages was shown on purpose', () => {
    expect(parseHiddenSections([])).toEqual([]);
  });

  it('keeps the sections that exist, once each', () => {
    expect(parseHiddenSections(['userSpace', 'views', 'userSpace'])).toEqual([
      'userSpace',
      'views',
    ]);
  });

  it('ignores ids that name no section', () => {
    expect(parseHiddenSections(['userSpace', 'inbox', 3, null])).toEqual(['userSpace']);
    expect(parseHiddenSections(['inbox'])).toEqual([]);
  });

  it.each([['userSpace'], [{}], [7], [true], ['[]']])(
    'falls back to the default when what was remembered is %j, not a list',
    (remembered) => {
      expect(parseHiddenSections(remembered)).toEqual(['userSpace']);
    },
  );

  it('never hides every section, which would leave the sidebar with none', () => {
    const every = SIDEBAR_SECTIONS.map((section) => section.id);
    expect(parseHiddenSections(every)).toEqual(['userSpace']);
    expect(parseHiddenSections([...every].reverse())).toEqual(['userSpace']);
  });

  it('hands back a list of its own, so changing it changes no other', () => {
    const first = parseHiddenSections(undefined);
    first.push('views');
    expect(parseHiddenSections(undefined)).toEqual(['userSpace']);
  });
});

describe('withSectionShown', () => {
  it('shows a hidden section', () => {
    expect(
      withSectionShown({ hidden: ['userSpace', 'views'], section: 'userSpace', shown: true }),
    ).toEqual(['views']);
  });

  it('hides a shown section', () => {
    expect(withSectionShown({ hidden: [], section: 'userSpace', shown: false })).toEqual([
      'userSpace',
    ]);
  });

  it('changes nothing when the section is already so', () => {
    expect(
      withSectionShown({ hidden: ['userSpace'], section: 'userSpace', shown: false }),
    ).toBeNull();
    expect(withSectionShown({ hidden: [], section: 'userSpace', shown: true })).toBeNull();
  });

  it('refuses to hide the last section shown, which would leave the sidebar empty', () => {
    const others = ['favorites', 'types', 'views', 'dashboards'] as const;
    expect(withSectionShown({ hidden: others, section: 'userSpace', shown: false })).toBeNull();
  });

  it('never makes a list that parseHiddenSections would refuse', () => {
    const ids = SIDEBAR_SECTIONS.map((section) => section.id);
    for (let mask = 0; mask < 1 << ids.length; mask += 1) {
      const hidden = ids.filter((_, at) => (mask & (1 << at)) !== 0);
      for (const section of ids) {
        for (const shown of [true, false]) {
          const next = withSectionShown({ hidden, section, shown });
          if (next !== null) expect(parseHiddenSections(next)).toEqual(next);
        }
      }
    }
  });
});
