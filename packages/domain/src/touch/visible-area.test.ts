import { describe, expect, it } from 'vitest';
import {
  CARET_MARGIN,
  caretScrollBy,
  keyboardChange,
  keyboardInset,
  placePopup,
  POPUP_GAP,
  type Area,
} from './visible-area.ts';

/** An iPad on its side, before the keyboard: 1180 by 820. */
const WINDOW: Area = { top: 0, left: 0, width: 1180, height: 820 };
/** The same, with the keyboard up over the lower 400px. */
const ABOVE_KEYBOARD: Area = { top: 0, left: 0, width: 1180, height: 420 };
/** A caret 20px tall, with its left at 300. */
const caretAt = (top: number, left = 300): Area => ({ top, left, width: 0, height: 20 });
const POPUP = { width: 240, height: 320 };

describe('placePopup', () => {
  it('hangs under the caret, a gap below it, when it fits there', () => {
    const placed = placePopup({ anchor: caretAt(100), size: POPUP, visible: WINDOW });
    expect(placed).toEqual({ top: 120 + POPUP_GAP, left: 300, flipped: false, maxHeight: null });
  });

  it('flips above the caret when the keyboard leaves no room under it', () => {
    // The caret at 360 leaves 34px below it within 420; the popup needs 320.
    const placed = placePopup({ anchor: caretAt(360), size: POPUP, visible: ABOVE_KEYBOARD });
    expect(placed).toEqual({
      top: 360 - POPUP_GAP - 320,
      left: 300,
      flipped: true,
      maxHeight: null,
    });
    expect(placed.top).toBeGreaterThanOrEqual(ABOVE_KEYBOARD.top);
  });

  it('flips at the first pixel that does not fit, not before', () => {
    // Under the caret there is exactly the popup's height: it stays below.
    const justFits = caretAt(WINDOW.height - 20 - POPUP_GAP - POPUP.height);
    expect(placePopup({ anchor: justFits, size: POPUP, visible: WINDOW }).flipped).toBe(false);
    const onePixelShort = caretAt(justFits.top + 1);
    expect(placePopup({ anchor: onePixelShort, size: POPUP, visible: WINDOW }).flipped).toBe(true);
  });

  it('takes the roomier side, held to its room, when neither side has room for all of it', () => {
    // 420 visible, caret at 200: 174px above, 194px below.
    const below = placePopup({ anchor: caretAt(200), size: POPUP, visible: ABOVE_KEYBOARD });
    expect(below).toEqual({ top: 220 + POPUP_GAP, left: 300, flipped: false, maxHeight: 194 });
    // Caret at 240: 234px above, 154px below.
    const above = placePopup({ anchor: caretAt(240), size: POPUP, visible: ABOVE_KEYBOARD });
    expect(above).toEqual({ top: 0, left: 300, flipped: true, maxHeight: 234 });
  });

  it('measures room from the visible area, not from the page top', () => {
    // The visual viewport scrolled down 500px within the layout: the caret at 560
    // is near its top, so the popup goes below, and flips above only against 500.
    const scrolled: Area = { top: 500, left: 0, width: 1180, height: 420 };
    const placed = placePopup({ anchor: caretAt(560), size: POPUP, visible: scrolled });
    expect(placed).toEqual({ top: 580 + POPUP_GAP, left: 300, flipped: false, maxHeight: null });
    const low = placePopup({
      anchor: caretAt(900),
      size: { width: 240, height: 100 },
      visible: scrolled,
    });
    expect(low).toEqual({ top: 900 - POPUP_GAP - 100, left: 300, flipped: true, maxHeight: null });
  });

  it('slides a popup back from the right edge, and never past the left one', () => {
    const narrow: Area = { top: 0, left: 0, width: 400, height: 820 };
    expect(placePopup({ anchor: caretAt(100, 300), size: POPUP, visible: narrow }).left).toBe(160);
    const inset: Area = { top: 0, left: 50, width: 200, height: 820 };
    expect(placePopup({ anchor: caretAt(100, 10), size: POPUP, visible: inset }).left).toBe(50);
  });

  it('judges a caret the keyboard covers from the visible edge, so the popup is not under it too', () => {
    const hidden = placePopup({ anchor: caretAt(600), size: POPUP, visible: ABOVE_KEYBOARD });
    expect(hidden).toEqual({
      top: 420 - POPUP_GAP - 320,
      left: 300,
      flipped: true,
      maxHeight: null,
    });
  });

  it('never gives a negative height', () => {
    const atTop = placePopup({
      anchor: caretAt(0),
      size: POPUP,
      visible: { ...WINDOW, height: 10 },
    });
    expect(atTop.maxHeight).toBe(0);
  });
});

describe('caretScrollBy', () => {
  it('is nothing while the caret is in view with its margin', () => {
    expect(caretScrollBy({ caret: caretAt(100), visible: ABOVE_KEYBOARD })).toBe(0);
    expect(caretScrollBy({ caret: caretAt(400 - CARET_MARGIN), visible: ABOVE_KEYBOARD })).toBe(0);
    expect(caretScrollBy({ caret: caretAt(CARET_MARGIN), visible: ABOVE_KEYBOARD })).toBe(0);
  });

  it('scrolls down by what the keyboard covers, plus the margin', () => {
    // The caret's bottom at 520, the visible bottom at 420.
    expect(caretScrollBy({ caret: caretAt(500), visible: ABOVE_KEYBOARD })).toBe(
      100 + CARET_MARGIN,
    );
    expect(caretScrollBy({ caret: caretAt(401), visible: ABOVE_KEYBOARD })).toBe(1 + CARET_MARGIN);
  });

  it('scrolls up when the caret is above the visible area', () => {
    const scrolled: Area = { top: 500, left: 0, width: 1180, height: 420 };
    expect(caretScrollBy({ caret: caretAt(450), visible: scrolled })).toBe(-50 - CARET_MARGIN);
  });

  it('keeps the margin it is handed', () => {
    expect(caretScrollBy({ caret: caretAt(400), visible: ABOVE_KEYBOARD, margin: 0 })).toBe(0);
    expect(caretScrollBy({ caret: caretAt(400), visible: ABOVE_KEYBOARD, margin: 30 })).toBe(30);
  });
});

describe('keyboardChange', () => {
  const coarse = { coarsePointer: true };

  it('is the keyboard rising when the height shrinks and the width does not, on a touch screen', () => {
    expect(keyboardChange({ before: WINDOW, after: ABOVE_KEYBOARD, ...coarse })).toBe('rose');
  });

  it('is the keyboard going when the height grows back with the width unchanged', () => {
    expect(keyboardChange({ before: ABOVE_KEYBOARD, after: WINDOW, ...coarse })).toBe('fell');
  });

  it('is not a keyboard on a desktop, whatever its window does (review of PR #744)', () => {
    const fine = { coarsePointer: false };
    expect(keyboardChange({ before: WINDOW, after: ABOVE_KEYBOARD, ...fine })).toBe('none');
    expect(keyboardChange({ before: ABOVE_KEYBOARD, after: WINDOW, ...fine })).toBe('none');
  });

  it('is not a keyboard when the width changes too: a window resized, a pinch-zoom', () => {
    const zoomed: Area = { top: 0, left: 0, width: 590, height: 410 };
    expect(keyboardChange({ before: WINDOW, after: zoomed, ...coarse })).toBe('none');
    expect(keyboardChange({ before: zoomed, after: WINDOW, ...coarse })).toBe('none');
  });

  it('is nothing when only the place changed: a pan, or the same size again', () => {
    const panned: Area = { ...ABOVE_KEYBOARD, top: 300 };
    expect(keyboardChange({ before: ABOVE_KEYBOARD, after: panned, ...coarse })).toBe('none');
    expect(keyboardChange({ before: WINDOW, after: { ...WINDOW }, ...coarse })).toBe('none');
  });
});

describe('keyboardInset', () => {
  it('is the part of the window below the visible area: what the keyboard covers', () => {
    expect(keyboardInset({ windowHeight: 820, visible: ABOVE_KEYBOARD })).toBe(400);
  });

  it('is nothing when the visible area reaches the bottom of the window', () => {
    expect(keyboardInset({ windowHeight: 820, visible: WINDOW })).toBe(0);
  });

  it('counts a visible area scrolled down within the window from where it ends', () => {
    const panned: Area = { top: 100, left: 0, width: 1180, height: 420 };
    expect(keyboardInset({ windowHeight: 820, visible: panned })).toBe(300);
  });

  it('is never negative', () => {
    const taller: Area = { top: 0, left: 0, width: 1180, height: 900 };
    expect(keyboardInset({ windowHeight: 820, visible: taller })).toBe(0);
  });
});
