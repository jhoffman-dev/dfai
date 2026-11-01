import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from 'react';
import { holdRemaining, judgePress, type PressPoint } from '@dfai/domain';

/** The handlers a long-pressable element spreads; a mouse's presses pass through them untouched. */
export interface LongPressHandlers {
  onPointerDown: (event: ReactPointerEvent<Element>) => void;
  onPointerMove: (event: ReactPointerEvent<Element>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onClickCapture: (event: SyntheticEvent) => void;
}

/**
 * A finger (or a pen) held on the element for the long-press rule's hold
 * (`LONG_PRESS`, the domain) calls `onLongPress` where it rests, and the tap
 * that lets go afterwards is not also a click (#659). A mouse is not a
 * finger: it has a right button for this, so its presses are left alone.
 * Only wiring lives here — which events, and one timer; whether a hold is a
 * long press yet, or has become a scroll, is `judgePress`'s to say.
 *
 * `now` is the clock the hold is measured on, in milliseconds; a test hands
 * in its own.
 */
export function useLongPress(
  onLongPress: (at: { x: number; y: number }) => void,
  { now = () => performance.now() }: { now?: () => number } = {},
): LongPressHandlers {
  const press = useRef<{ start: PressPoint; last: PressPoint; timer: number } | null>(null);
  const fired = useRef(false);
  const latest = useRef({ onLongPress, now });
  latest.current = { onLongPress, now };

  const clear = () => {
    if (press.current !== null) clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => clear, []);

  // Looks again once the hold should have passed: a timer can run early on
  // some clocks, and then it waits what is left rather than deciding on time.
  const check = () => {
    const held = press.current;
    if (held === null) return;
    const at = latest.current.now();
    const verdict = judgePress(held.start, { ...held.last, at });
    if (verdict === 'pending') {
      held.timer = window.setTimeout(check, holdRemaining(held.start, at));
      return;
    }
    clear();
    if (verdict !== 'long') return;
    fired.current = true;
    latest.current.onLongPress({ x: held.last.x, y: held.last.y });
  };

  return {
    onPointerDown: (event) => {
      if (event.pointerType === 'mouse' || !event.isPrimary) return;
      clear();
      fired.current = false;
      const start = { x: event.clientX, y: event.clientY, at: latest.current.now() };
      const timer = window.setTimeout(check, holdRemaining(start, start.at));
      press.current = { start, last: start, timer };
    },
    onPointerMove: (event) => {
      const held = press.current;
      if (held === null) return;
      const at = latest.current.now();
      held.last = { x: event.clientX, y: event.clientY, at };
      if (judgePress(held.start, held.last) === 'scrolled') clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onClickCapture: (event) => {
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
