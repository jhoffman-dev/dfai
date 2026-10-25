import { describe, expect, it } from 'vitest';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  fitZoom,
  toggledZoom,
  zoomedByWheel,
  zoomedIn,
  zoomedOut,
  zoomLabel,
  clampPan,
  panAfterZoom,
} from './image-zoom.ts';

describe('fitZoom', () => {
  it('shrinks a large image to the room, by its tighter side', () => {
    expect(
      fitZoom({ image: { width: 2000, height: 1000 }, room: { width: 1000, height: 800 } }),
    ).toBe(0.5);
    expect(
      fitZoom({ image: { width: 1000, height: 2000 }, room: { width: 1000, height: 800 } }),
    ).toBe(0.4);
  });

  it('never blows a small image up past its own pixels', () => {
    expect(
      fitZoom({ image: { width: 300, height: 200 }, room: { width: 1000, height: 800 } }),
    ).toBe(1);
  });

  it('is 1 before either size is known', () => {
    expect(fitZoom({ image: { width: 0, height: 0 }, room: { width: 1000, height: 800 } })).toBe(1);
    expect(fitZoom({ image: { width: 300, height: 200 }, room: { width: 0, height: 0 } })).toBe(1);
  });

  it('goes below the smallest zoom when an image needs it, and ⌘− from there zooms no further in', () => {
    const fit = fitZoom({
      image: { width: 100000, height: 10 },
      room: { width: 100, height: 100 },
    });
    expect(fit).toBe(0.001);
    expect(zoomedOut(fit)).toBe(fit);
    expect(zoomedByWheel(fit, 100)).toBeLessThanOrEqual(fit);
    expect(zoomedIn(fit)).toBe(MIN_ZOOM);
  });
});

describe('zoom stops', () => {
  it('steps in and out between stops', () => {
    expect(zoomedIn(1)).toBe(1.25);
    expect(zoomedOut(1)).toBe(0.75);
  });

  it('steps from a fit between stops to the next one either side', () => {
    expect(zoomedIn(0.42)).toBe(0.5);
    expect(zoomedOut(0.42)).toBe(0.33);
  });

  it('stops at the ends', () => {
    expect(zoomedIn(MAX_ZOOM)).toBe(MAX_ZOOM);
    expect(zoomedOut(MIN_ZOOM)).toBe(MIN_ZOOM);
  });
});

describe('zoomedByWheel', () => {
  it('zooms in on a scroll up and out on a scroll down', () => {
    expect(zoomedByWheel(1, -100)).toBeGreaterThan(1);
    expect(zoomedByWheel(1, 100)).toBeLessThan(1);
  });

  it('is held between the smallest and largest zoom', () => {
    expect(zoomedByWheel(MAX_ZOOM, -10000)).toBe(MAX_ZOOM);
    expect(zoomedByWheel(MIN_ZOOM, 10000)).toBe(MIN_ZOOM);
  });
});

describe('toggledZoom', () => {
  it('goes back to fit from any other zoom', () => {
    expect(toggledZoom(3, 0.5)).toBe(0.5);
  });

  it('goes from fit to the image’s own pixels', () => {
    expect(toggledZoom(0.5, 0.5)).toBe(1);
  });

  it('goes to twice its pixels when it already fits at them', () => {
    expect(toggledZoom(1, 1)).toBe(2);
  });
});

describe('zoomLabel', () => {
  it('says the zoom as a whole percentage', () => {
    expect(zoomLabel(0.333)).toBe('33%');
    expect(zoomLabel(1.25)).toBe('125%');
  });
});

describe('panAfterZoom', () => {
  it('keeps the point under the anchor still', () => {
    // The image point under the pointer, 100px right of centre, is (100 - 20) / 1 from the image's centre.
    const pan = panAfterZoom({ pan: { x: 20, y: 0 }, from: 1, to: 2, anchor: { x: 100, y: 0 } });
    expect(pan).toEqual({ x: -60, y: 0 });
    expect((100 - pan.x) / 2).toBe((100 - 20) / 1);
  });

  it('zooms about the centre when no anchor is given, scaling the pan', () => {
    expect(panAfterZoom({ pan: { x: 40, y: -10 }, from: 1, to: 2 })).toEqual({ x: 80, y: -20 });
  });
});

describe('clampPan', () => {
  const drawn = { width: 1000, height: 750 };
  const room = { width: 800, height: 600 };

  it('leaves a pan that keeps the image on screen as it is', () => {
    expect(clampPan({ pan: { x: 200, y: -100 }, drawn, room })).toEqual({ x: 200, y: -100 });
  });

  it('holds a pan so 48px of the image stays in the window', () => {
    expect(clampPan({ pan: { x: 99999, y: -99999 }, drawn, room })).toEqual({ x: 852, y: -627 });
  });
});
