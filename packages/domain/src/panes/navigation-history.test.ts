import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  backPlace,
  followMoveInHistory,
  forgetNotes,
  forwardPlace,
  goBack,
  goForward,
  HISTORY_LIMIT,
  NO_HISTORY,
  samePlace,
  visit,
  type NavigationHistory,
  type NavigationPlace,
} from './navigation-history.ts';

const note = (raw: string): NavigationPlace => ({ kind: 'note', path: createVaultPath(raw) });
const type = (name: string): NavigationPlace => ({ kind: 'type', name });
const QUERY: NavigationPlace = { kind: 'query' };
const VAULT_GRAPH: NavigationPlace = { kind: 'graph', scope: { kind: 'vault' } };
const noteGraph = (raw: string, depth: 1 | 2 = 1): NavigationPlace => ({
  kind: 'graph',
  scope: { kind: 'note', path: createVaultPath(raw), depth },
});

const visitAll = (...places: NavigationPlace[]) => places.reduce(visit, NO_HISTORY);
const goneAt =
  (...raws: string[]) =>
  (path: string) =>
    raws.includes(path);

describe('visit', () => {
  it('makes the place current and puts the one before it behind Back', () => {
    const history = visitAll(note('A.md'), note('B.md'));
    expect(history.current).toEqual(note('B.md'));
    expect(backPlace(history)).toEqual(note('A.md'));
    expect(forwardPlace(history)).toBeNull();
  });

  it('has nowhere to go back to from the first place', () => {
    const history = visitAll(note('A.md'));
    expect(backPlace(history)).toBeNull();
    expect(goBack(history)).toBe(history);
  });

  it('is not a step when the place is already current, and hands back the same history', () => {
    const history = visitAll(note('A.md'), note('B.md'));
    expect(visit(history, note('B.md'))).toBe(history);
  });

  it('forgets Forward when something new is opened, as a browser does', () => {
    const back = goBack(visitAll(note('A.md'), note('B.md')));
    expect(forwardPlace(back)).toEqual(note('B.md'));

    const branched = visit(back, note('C.md'));
    expect(forwardPlace(branched)).toBeNull();
    expect(branched.back).toEqual([note('A.md')]);
  });

  it(`remembers at most ${HISTORY_LIMIT} places behind, forgetting the oldest`, () => {
    const places = Array.from({ length: HISTORY_LIMIT + 5 }, (_, at) => note(`n${at}.md`));
    const history = visitAll(...places);
    expect(history.back).toHaveLength(HISTORY_LIMIT);
    expect(history.back[0]).toEqual(note('n4.md'));
    expect(backPlace(history)).toEqual(note(`n${HISTORY_LIMIT + 3}.md`));
  });

  it('records types, the graph and the query page, not only notes', () => {
    const history = visitAll(note('A.md'), type('task'), VAULT_GRAPH, QUERY);
    expect(history.back).toEqual([note('A.md'), type('task'), VAULT_GRAPH]);
    expect(history.current).toEqual(QUERY);
  });
});

describe('goBack and goForward', () => {
  it('walk back and forward through what was opened', () => {
    const opened = visitAll(note('A.md'), note('B.md'), note('C.md'));

    const once = goBack(opened);
    expect(once.current).toEqual(note('B.md'));
    const twice = goBack(once);
    expect(twice.current).toEqual(note('A.md'));
    expect(backPlace(twice)).toBeNull();
    expect(twice.forward).toEqual([note('B.md'), note('C.md')]);

    const again = goForward(twice);
    expect(again.current).toEqual(note('B.md'));
    expect(goForward(again).current).toEqual(note('C.md'));
    expect(forwardPlace(goForward(again))).toBeNull();
  });

  it('are the same history when there is nowhere to go', () => {
    const history = visitAll(note('A.md'));
    expect(goForward(history)).toBe(history);
    expect(goBack(NO_HISTORY)).toBe(NO_HISTORY);
  });

  it('going back from an emptied pane lands on the last place, not one before it', () => {
    const emptied = forgetNotes(visitAll(note('A.md'), note('B.md')), goneAt('B.md'));
    expect(emptied.current).toBeNull();
    const back = goBack(emptied);
    expect(back.current).toEqual(note('A.md'));
    expect(back.forward).toEqual([]);
  });

  it('going forward from an emptied pane does not put the empty place behind Back', () => {
    const history: NavigationHistory = {
      back: [note('A.md')],
      current: null,
      forward: [note('C.md')],
    };
    const forward = goForward(history);
    expect(forward.current).toEqual(note('C.md'));
    expect(forward.back).toEqual([note('A.md')]);
  });
});

describe('samePlace', () => {
  it('tells pages apart by what they show', () => {
    expect(samePlace(note('A.md'), note('A.md'))).toBe(true);
    expect(samePlace(note('A.md'), note('B.md'))).toBe(false);
    expect(samePlace(type('task'), type('task'))).toBe(true);
    expect(samePlace(type('task'), type('book'))).toBe(false);
    expect(samePlace(QUERY, { kind: 'query' })).toBe(true);
    expect(samePlace(VAULT_GRAPH, { kind: 'graph', scope: { kind: 'vault' } })).toBe(true);
    expect(samePlace(VAULT_GRAPH, noteGraph('A.md'))).toBe(false);
    expect(samePlace(noteGraph('A.md'), VAULT_GRAPH)).toBe(false);
    expect(samePlace(noteGraph('A.md'), noteGraph('A.md', 2))).toBe(false);
    expect(samePlace(noteGraph('A.md'), noteGraph('B.md'))).toBe(false);
    expect(samePlace(noteGraph('A.md', 2), noteGraph('A.md', 2))).toBe(true);
    expect(samePlace(note('A.md'), type('A.md'))).toBe(false);
    expect(samePlace({ kind: 'activity' }, { kind: 'activity' })).toBe(true);
    expect(samePlace({ kind: 'activity' }, { kind: 'automations' })).toBe(false);
    expect(samePlace({ kind: 'inbox' }, { kind: 'inbox' })).toBe(true);
    expect(samePlace({ kind: 'inbox' }, { kind: 'archive' })).toBe(false);
    expect(samePlace({ kind: 'review' }, { kind: 'review' })).toBe(true);
    expect(samePlace({ kind: 'review' }, { kind: 'inbox' })).toBe(false);
    expect(samePlace({ kind: 'today' }, { kind: 'today' })).toBe(true);
    expect(samePlace({ kind: 'today' }, { kind: 'review' })).toBe(false);
    expect(samePlace(QUERY, note('A.md'))).toBe(false);
    expect(samePlace({ kind: 'tags', tag: null }, { kind: 'tags', tag: null })).toBe(true);
    expect(samePlace({ kind: 'tags', tag: 'idea' }, { kind: 'tags', tag: 'idea' })).toBe(true);
    expect(samePlace({ kind: 'tags', tag: 'idea' }, { kind: 'tags', tag: null })).toBe(false);
    expect(samePlace({ kind: 'tags', tag: null }, QUERY)).toBe(false);
    expect(samePlace({ kind: 'terms' }, { kind: 'terms' })).toBe(true);
    expect(samePlace({ kind: 'terms' }, { kind: 'templates' })).toBe(false);
    expect(samePlace({ kind: 'skills' }, { kind: 'skills' })).toBe(true);
    expect(samePlace({ kind: 'skills' }, { kind: 'templates' })).toBe(false);
  });
});

describe('forgetNotes', () => {
  it('drops a deleted note from Forward, so Forward is disabled rather than broken', () => {
    const back = goBack(visitAll(note('A.md'), note('B.md')));
    const forgotten = forgetNotes(back, goneAt('B.md'));
    expect(forgotten.current).toEqual(note('A.md'));
    expect(forwardPlace(forgotten)).toBeNull();
  });

  it('skips a deleted note behind Back, and merges the steps it separated', () => {
    const history = visitAll(note('A.md'), note('B.md'), note('A.md'), note('C.md'));
    const forgotten = forgetNotes(history, goneAt('B.md'));
    expect(forgotten.back).toEqual([note('A.md')]);
    expect(forgotten.current).toEqual(note('C.md'));
  });

  it('does not leave Back or Forward one step that only repeats the current place', () => {
    const history: NavigationHistory = {
      back: [note('A.md'), note('B.md')],
      current: note('A.md'),
      forward: [note('B.md'), note('A.md'), note('C.md')],
    };
    const forgotten = forgetNotes(history, goneAt('B.md'));
    expect(forgotten).toEqual({ back: [], current: note('A.md'), forward: [note('C.md')] });
  });

  it('forgets a graph centred on a deleted note, but not the whole-vault graph', () => {
    const history = visitAll(VAULT_GRAPH, noteGraph('B.md'), type('task'));
    expect(forgetNotes(history, goneAt('B.md')).back).toEqual([VAULT_GRAPH]);
  });

  it('empties the current place when it is the note deleted', () => {
    const history = visitAll(note('A.md'), note('B.md'));
    expect(forgetNotes(history, goneAt('B.md'))).toEqual({
      back: [note('A.md')],
      current: null,
      forward: [],
    });
  });

  it('hands back the same history when nothing in it is gone', () => {
    const history = visitAll(note('A.md'), type('task'), QUERY);
    expect(forgetNotes(history, goneAt('Z.md'))).toBe(history);
  });
});

describe('followMoveInHistory', () => {
  const move = { from: createVaultPath('Old'), to: createVaultPath('New') };

  it('follows a moved note, and every note under a moved folder, wherever it is in history', () => {
    const history = goBack(visitAll(note('Old/A.md'), note('Keep.md'), note('Old/Deep/B.md')));
    const followed = followMoveInHistory(history, move);
    expect(followed.back).toEqual([note('New/A.md')]);
    expect(followed.current).toEqual(note('Keep.md'));
    expect(followed.forward).toEqual([note('New/Deep/B.md')]);
  });

  it('follows a graph centred on a moved note, and leaves other places alone', () => {
    const history = visitAll(noteGraph('Old/A.md', 2), VAULT_GRAPH, type('task'), QUERY);
    const followed = followMoveInHistory(history, move);
    expect(followed.back).toEqual([noteGraph('New/A.md', 2), VAULT_GRAPH, type('task')]);
    expect(followed.current).toEqual(QUERY);
  });

  it('keeps an empty current place empty', () => {
    expect(followMoveInHistory(NO_HISTORY, move)).toEqual(NO_HISTORY);
  });
});

describe('followMoveInHistory identity', () => {
  it('is the same history when no place is on the moved note', () => {
    const history = visit(visit(NO_HISTORY, { kind: 'note', path: createVaultPath('Acme.md') }), {
      kind: 'graph',
      scope: { kind: 'note', path: createVaultPath('Beta.md'), depth: 1 },
    });
    const move = { from: createVaultPath('Gamma.md'), to: createVaultPath('Delta.md') };
    expect(followMoveInHistory(history, move)).toBe(history);
    expect(followMoveInHistory(NO_HISTORY, move)).toBe(NO_HISTORY);
  });
});
