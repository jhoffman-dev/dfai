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

  it('is never below the smallest zoom', () => {
    expect(
      fitZoom({ image: { width: 100000, height: 10 }, room: { width: 100, height: 100 } }),
    ).toBe(MIN_ZOOM);
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
