import { describe, expect, it, vi } from 'vitest';
import { createAskFocus } from './ask-focus.ts';

describe('createAskFocus (#37)', () => {
  it('holds nothing until asked, then a request for the pane that is pending until taken', () => {
    const focus = createAskFocus();
    const heard = vi.fn();
    focus.subscribe(heard);
    expect(focus.pending(focus.latest())).toBe(false);
    focus.request(1);
    const asked = focus.latest();
    expect(asked?.pane).toBe(1);
    expect(focus.pending(asked)).toBe(true);
    focus.taken(asked?.serial ?? 0);
    expect(focus.pending(asked)).toBe(false);
    // Taking it changes nothing a subscriber reads, and tells no one.
    expect(focus.latest()).toBe(asked);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('makes asking the same pane twice two requests, each pending until its own is taken', () => {
    const focus = createAskFocus();
    focus.request(0);
    const first = focus.latest();
    focus.taken(first?.serial ?? 0);
    focus.request(0);
    const second = focus.latest();
    expect(second).not.toBe(first);
    expect(focus.pending(second)).toBe(true);
    focus.taken(first?.serial ?? 0);
    expect(focus.pending(second)).toBe(true);
  });
});
