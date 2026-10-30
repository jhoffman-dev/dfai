// @vitest-environment jsdom
/**
 * Focusing a row the Today page has not put in the DOM (#238): it is asked
 * for, and it takes the focus as it is drawn.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createVaultPath, type VaultPath } from '@dfai/domain';
import { useRowFocus } from './today-row-focus.ts';

const first = createVaultPath('Tasks/First.md');
const far = createVaultPath('Tasks/Far.md');

function mounted(): HTMLInputElement {
  const box = document.createElement('input');
  box.type = 'checkbox';
  document.body.append(box);
  return box;
}

describe('useRowFocus — a row not in the DOM', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('focuses a row in the DOM at once, wanting none', () => {
    const { result } = renderHook(() =>
      useRowFocus({ order: [first, far], shown: {}, problem: null }),
    );
    const box = mounted();
    result.current.rowRef(first)(box);

    act(() => result.current.focusRow(first));

    expect(document.activeElement).toBe(box);
    expect(result.current.wanted).toBeNull();
  });

  it('wants a row that is not drawn, and focuses it once it is', () => {
    const { result } = renderHook(() =>
      useRowFocus({ order: [first, far], shown: {}, problem: null }),
    );

    act(() => result.current.focusRow(far));
    expect(result.current.wanted).toBe(far);

    const box = mounted();
    act(() => result.current.rowRef(far)(box));

    expect(document.activeElement).toBe(box);
    expect(result.current.wanted).toBeNull();
  });

  it('does not focus another row drawn while one is wanted', () => {
    const { result } = renderHook(() =>
      useRowFocus({ order: [first, far], shown: {}, problem: null }),
    );
    act(() => result.current.focusRow(far));

    const other = mounted();
    act(() => result.current.rowRef(first)(other));

    expect(document.activeElement).not.toBe(other);
    expect(result.current.wanted).toBe(far);
  });

  it('leaves the focus on a control the person put it on before the wanted row is drawn', () => {
    const { result } = renderHook(() =>
      useRowFocus({ order: [first, far], shown: {}, problem: null }),
    );
    act(() => result.current.focusRow(far));
    const theirs = mounted();
    theirs.focus();

    const box = mounted();
    act(() => result.current.rowRef(far)(box));

    expect(document.activeElement).toBe(theirs);
    expect(result.current.wanted).toBeNull();
  });

  it('forgets a wanted row that leaves the order, so it takes no focus when it comes back', () => {
    const { result, rerender } = renderHook(
      ({ order }) => useRowFocus({ order, shown: {}, problem: null }),
      { initialProps: { order: [first, far] } },
    );
    act(() => result.current.focusRow(far));
    rerender({ order: [first] });
    expect(result.current.wanted).toBeNull();

    rerender({ order: [first, far] });
    const box = mounted();
    act(() => result.current.rowRef(far)(box));

    expect(document.activeElement).not.toBe(box);
  });

  it('wants no row that is not in the order', () => {
    const { result } = renderHook(() => useRowFocus({ order: [first], shown: {}, problem: null }));

    act(() => result.current.focusRow(far));

    expect(result.current.wanted).toBeNull();
  });
});

describe('useRowFocus — a row that leaves while its action is under way (#260)', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('focuses the next row once the action is done, when its controls can take the focus', () => {
    const next = mounted();
    next.disabled = true;
    const { result, rerender } = renderHook(
      ({ order, busy }) => useRowFocus({ order, shown: { order }, problem: null, busy }),
      { initialProps: { order: [first, far], busy: false } },
    );
    act(() => result.current.rowRef(far)(next));
    act(() => result.current.actedOn(first));

    // The row leaves at once, while every row's controls wait for its write.
    rerender({ order: [far], busy: true });
    expect(document.activeElement).not.toBe(next);

    next.disabled = false;
    rerender({ order: [far], busy: false });
    expect(document.activeElement).toBe(next);
  });
});

describe('useRowFocus — a row put back when its action is refused (#260, PR #274)', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('gives the focus back to the row once it is back on the page', () => {
    const acted = mounted();
    const { result, rerender } = renderHook(
      ({ order, problem, busy }) => useRowFocus({ order, shown: { order }, problem, busy }),
      { initialProps: { order: [first, far], problem: null as string | null, busy: false } },
    );
    act(() => result.current.rowRef(first)(acted));
    act(() => result.current.actedOn(first));

    // Taken off at once, while its write is held: the focus goes to the document.
    acted.remove();
    rerender({ order: [far], problem: null, busy: true });
    act(() => result.current.rowRef(first)(null));

    // Refused: the problem is said, then the row is drawn again.
    rerender({ order: [far], problem: 'The disk is full.', busy: false });
    const back = mounted();
    act(() => result.current.rowRef(first)(back));
    rerender({ order: [first, far], problem: 'The disk is full.', busy: false });

    expect(document.activeElement).toBe(back);
  });
});

describe('useRowFocus — a row acted on that stays on the page (PR #641 review)', () => {
  const a = createVaultPath('Tasks/A.md');
  const b = createVaultPath('Tasks/B.md');
  const c = createVaultPath('Tasks/C.md');
  const order = [a, b, c];

  afterEach(() => {
    document.body.replaceChildren();
  });

  /** The hook over a page whose read places each row in a section, and says which rows settle. */
  function placedHook(place: Record<string, string>) {
    const placeOf = (path: string) => place[path] ?? null;
    const hook = renderHook(
      (props: { shown: object; settling: ReadonlySet<VaultPath> }) =>
        useRowFocus({ order, problem: null, placeOf, ...props }),
      { initialProps: { shown: {}, settling: new Set<VaultPath>() } },
    );
    const boxes = new Map(order.map((path) => [path, mounted()]));
    for (const [path, box] of boxes) act(() => hook.result.current.rowRef(path)(box));
    return { ...hook, boxes, place };
  }

  it('forgets it once its change is read back where it was: a later read, with its row scrolled away, moves no focus', () => {
    const { result, rerender, boxes } = placedHook({
      [a]: 'nextActions',
      [b]: 'nextActions',
      [c]: 'waiting',
    });
    // A press with the pointer: WebKit leaves the focus on the page.
    act(() => result.current.actedOn(a));
    rerender({ shown: {}, settling: new Set([a]) });
    rerender({ shown: {}, settling: new Set() });
    // Scrolled out of the page, its row is taken out of the DOM by the virtualiser.
    act(() => result.current.rowRef(a)(null));
    boxes.get(a)?.remove();
    // Sync reads the page again, later.
    rerender({ shown: {}, settling: new Set() });
    expect(document.activeElement).toBe(document.body);
  });

  it('once read back where it was, is not taken for moved when sync later lists it elsewhere', () => {
    const { result, rerender, place } = placedHook({
      [a]: 'nextActions',
      [b]: 'nextActions',
      [c]: 'waiting',
    });
    act(() => result.current.actedOn(a));
    rerender({ shown: {}, settling: new Set([a]) });
    rerender({ shown: {}, settling: new Set() });
    // Another Mac changes its status: the next read lists it under Waiting.
    place[a] = 'waiting';
    rerender({ shown: {}, settling: new Set() });
    expect(document.activeElement).toBe(document.body);
  });

  it('hands the focus on when the read shows the row in another section, its focus lost with the old one', () => {
    const { result, rerender, boxes, place } = placedHook({
      [a]: 'nextActions',
      [b]: 'nextActions',
      [c]: 'waiting',
    });
    act(() => boxes.get(a)?.focus());
    act(() => result.current.actedOn(a));
    // Chosen for today: drawn anew at the top, the old row and its focus gone.
    place[a] = 'chosen';
    act(() => result.current.rowRef(a)(null));
    boxes.get(a)?.remove();
    rerender({ shown: {}, settling: new Set([a]) });
    expect(document.activeElement).toBe(boxes.get(b));
  });

  it('leaves the focus alone when the row is still where it was and only scrolled away', () => {
    const { result, rerender, boxes } = placedHook({
      [a]: 'nextActions',
      [b]: 'nextActions',
      [c]: 'waiting',
    });
    act(() => result.current.actedOn(a));
    act(() => result.current.rowRef(a)(null));
    boxes.get(a)?.remove();
    rerender({ shown: {}, settling: new Set([a]) });
    expect(document.activeElement).toBe(document.body);
  });
});
