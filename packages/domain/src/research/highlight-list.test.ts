import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  CHANGED_WITHIN_MS,
  filterHighlights,
  hasComment,
  highlightChoices,
  highlightColor,
  highlightEmbed,
  highlightPlace,
  isHighlightFiltered,
  settleHighlightFilter,
  flattenHighlights,
  inDisplayOrder,
  NO_HIGHLIGHT_FILTER,
  type HighlightEntry,
  type SourceHighlights,
} from './highlight-list.ts';
import type { LibraryEntry } from './library.ts';

/** A fixed clock: noon on 2026-10-22. */
const NOW = Date.UTC(2026, 9, 22, 12);
const DAY = 86_400_000;
const ART = createVaultPath('Library/The Art of War.md');
const STOIC = createVaultPath('Library/Meditations.md');

function highlight(id: string, rest: Partial<HighlightEntry> = {}): HighlightEntry {
  return {
    path: ART,
    source: 'The Art of War',
    modified: NOW,
    index: 0,
    id,
    kind: 'pdf',
    quote: `Quote ${id}`,
    comment: '',
    mark: 'highlight',
    color: 'yellow',
    page: null,
    location: null,
    tags: [],
    ...rest,
  };
}

const ids = (entries: readonly HighlightEntry[]) => entries.map((each) => each.id);

describe('filterHighlights', () => {
  const all = [
    highlight('a1', { color: 'yellow', comment: 'Compare the pitch.', tags: ['strategy'] }),
    highlight('a2', { color: 'green', comment: '   ', modified: NOW - 10 * DAY }),
    highlight('b1', {
      path: STOIC,
      source: 'Meditations',
      color: 'teal',
      tags: ['stoic'],
      modified: NOW - 100 * DAY,
    }),
    highlight('b2', {
      path: STOIC,
      source: 'Meditations',
      color: 'pink',
      modified: NOW - 400 * DAY,
    }),
  ];
  const shown = (filter: Partial<typeof NO_HIGHLIGHT_FILTER>) =>
    ids(filterHighlights(all, { ...NO_HIGHLIGHT_FILTER, ...filter }, NOW));

  it('shows every highlight with no filter, in the order given', () => {
    expect(shown({})).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('shows one source', () => {
    expect(shown({ source: STOIC })).toEqual(['b1', 'b2']);
  });

  it('shows the colours asked for, a colour this build does not know as yellow', () => {
    expect(shown({ colors: ['yellow'] })).toEqual(['a1', 'b1']);
    expect(shown({ colors: ['green', 'pink'] })).toEqual(['a2', 'b2']);
  });

  it('shows the highlights whose note has a tag', () => {
    expect(shown({ tag: 'stoic' })).toEqual(['b1']);
  });

  it('shows those with a comment, or those without, a comment of spaces being none', () => {
    expect(shown({ comment: 'with' })).toEqual(['a1']);
    expect(shown({ comment: 'without' })).toEqual(['a2', 'b1', 'b2']);
  });

  it('shows those whose note changed within a week, a month or a year of the clock', () => {
    expect(shown({ changed: 'week' })).toEqual(['a1']);
    expect(shown({ changed: 'month' })).toEqual(['a1', 'a2']);
    expect(shown({ changed: 'year' })).toEqual(['a1', 'a2', 'b1']);
  });

  it('counts the edge of a span in, and a note changed ahead of the clock too', () => {
    const edge = [
      highlight('edge', { modified: NOW - CHANGED_WITHIN_MS.week }),
      highlight('past', { modified: NOW - CHANGED_WITHIN_MS.week - 1 }),
      highlight('ahead', { modified: NOW + DAY }),
    ];
    expect(ids(filterHighlights(edge, { ...NO_HIGHLIGHT_FILTER, changed: 'week' }, NOW))).toEqual([
      'edge',
      'ahead',
    ]);
  });

  it('leaves out a highlight whose note cannot be dated from any span: never changed since (ADR-0053)', () => {
    const undated = [highlight('dated'), highlight('undated', { modified: null })];
    expect(
      ids(filterHighlights(undated, { ...NO_HIGHLIGHT_FILTER, changed: 'week' }, NOW)),
    ).toEqual(['dated']);
    expect(ids(filterHighlights(undated, NO_HIGHLIGHT_FILTER, NOW))).toEqual(['dated', 'undated']);
  });

  it('holds every filter at once', () => {
    expect(
      shown({ source: ART, colors: ['yellow'], tag: 'strategy', comment: 'with', changed: 'week' }),
    ).toEqual(['a1']);
    expect(shown({ source: ART, comment: 'without', colors: ['yellow'] })).toEqual([]);
  });
});

describe('highlightColor', () => {
  it('is the colour when this build knows it, else yellow', () => {
    expect(highlightColor('purple')).toBe('purple');
    expect(highlightColor('teal')).toBe('yellow');
    expect(highlightColor('')).toBe('yellow');
  });
});

describe('hasComment', () => {
  it('is false for no comment and for one of only spaces', () => {
    expect(hasComment({ comment: '' })).toBe(false);
    expect(hasComment({ comment: ' \n\t' })).toBe(false);
    expect(hasComment({ comment: 'x' })).toBe(true);
  });
});

describe('highlightPlace', () => {
  it('says a Kindle location before a page, a page alone, and nothing for neither', () => {
    expect(highlightPlace({ location: 77, page: 5 })).toBe('Location 77');
    expect(highlightPlace({ location: null, page: 3 })).toBe('Page 3');
    expect(highlightPlace({ location: null, page: null })).toBeNull();
  });
});

describe('highlightEmbed', () => {
  it("is Obsidian's embed of the block", () => {
    expect(highlightEmbed({ target: 'The Art of War', id: 'k3x9q2' })).toBe(
      '![[The Art of War#^k3x9q2]]',
    );
  });
});

describe('highlightChoices', () => {
  it('offers each source by title, each colour present in its own order, each tag, with counts', () => {
    const choices = highlightChoices([
      highlight('a1', { color: 'green', tags: ['strategy'] }),
      highlight('a2', { color: 'teal', tags: ['strategy'] }),
      highlight('b1', { path: STOIC, source: 'Meditations', color: 'green', tags: ['stoic'] }),
    ]);
    expect(choices.sources).toEqual([
      { value: STOIC, label: 'Meditations', count: 1 },
      { value: ART, label: 'The Art of War', count: 2 },
    ]);
    expect(choices.colors).toEqual([
      { value: 'yellow', label: 'Yellow', count: 1 },
      { value: 'green', label: 'Green', count: 2 },
    ]);
    expect(choices.tags).toEqual([
      { value: 'stoic', label: '#stoic', count: 1 },
      { value: 'strategy', label: '#strategy', count: 2 },
    ]);
  });
});

describe('inDisplayOrder and flattenHighlights', () => {
  const group = (path: string, modified: number, ...ids: string[]): SourceHighlights => {
    const source: LibraryEntry = {
      path: createVaultPath(path),
      title: path.replace(/^.*\//, '').replace(/\.md$/, ''),
      author: null,
      kind: 'pdf',
      highlights: ids.length,
      modified,
      tags: [],
      projects: [],
      cover: null,
    };
    return {
      source,
      highlights: ids.map((id, at) => highlight(id, { path: source.path, index: at, modified })),
    };
  };
  const listed = (groups: readonly SourceHighlights[]) =>
    ids(flattenHighlights(inDisplayOrder(groups)));

  it("lists the newest source first, then by path, each source's highlights as it holds them", () => {
    expect(
      listed([
        group('Library/Old.md', 1, 'o1'),
        group('Library/B.md', 9, 'b1', 'b2'),
        group('Library/A.md', 9, 'a1'),
      ]),
    ).toEqual(['a1', 'b1', 'b2', 'o1']);
  });

  it('orders paths as the index does, by code unit, so "B" comes before "a"', () => {
    expect(listed([group('Library/a.md', 1, 'lower'), group('Library/B.md', 1, 'upper')])).toEqual([
      'upper',
      'lower',
    ]);
  });

  it('keeps the order total for a source with no time of its own', () => {
    const groups = [group('Library/A.md', Number.NaN, 'a'), group('Library/B.md', 0, 'b')];
    expect(listed(groups)).toEqual(listed([...groups].reverse()));
  });

  it('is nothing for no sources, and does not reorder what it is given', () => {
    const given = [group('Library/A.md', 1, 'a'), group('Library/B.md', 2, 'b')];
    expect(flattenHighlights(inDisplayOrder([]))).toEqual([]);
    inDisplayOrder(given);
    expect(given.map((each) => each.source.title)).toEqual(['A', 'B']);
  });
});

describe('settleHighlightFilter and isHighlightFiltered', () => {
  const choices = highlightChoices([highlight('a1', { color: 'blue', tags: ['strategy'] })]);

  it('drops the source, colour and tag no highlight has any more, and keeps the rest', () => {
    const settled = settleHighlightFilter(
      {
        source: STOIC,
        colors: ['blue', 'green'],
        tag: 'gone',
        comment: 'with',
        changed: 'week',
      },
      choices,
    );
    expect(settled).toEqual({
      source: null,
      colors: ['blue'],
      tag: null,
      comment: 'with',
      changed: 'week',
    });
  });

  it('keeps a filter every value of which is still offered, as the same object', () => {
    const filter = {
      ...NO_HIGHLIGHT_FILTER,
      source: ART,
      colors: ['blue' as const],
      tag: 'strategy',
    };
    expect(settleHighlightFilter(filter, choices)).toBe(filter);
  });

  it('says a filter is on for any of the five', () => {
    expect(isHighlightFiltered(NO_HIGHLIGHT_FILTER)).toBe(false);
    for (const on of [
      { source: ART },
      { colors: ['blue' as const] },
      { tag: 'a' },
      { comment: 'with' as const },
      { changed: 'year' as const },
    ]) {
      expect(isHighlightFiltered({ ...NO_HIGHLIGHT_FILTER, ...on })).toBe(true);
    }
  });
});
