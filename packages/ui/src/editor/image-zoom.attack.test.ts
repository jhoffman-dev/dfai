import { describe, expect, it } from 'vitest';
import { fitZoom } from './image-zoom.ts';

/** Adversarial checks on the viewer's zoom (#568, PR #570). */

describe('fit, for an image far larger than the window', () => {
  it.each([
    [
      '10,000 px tall in a 600 px window',
      { width: 4000, height: 10_000 },
      { width: 1200, height: 600 },
    ],
    [
      'a 20,000 px panorama in a 1,200 px window',
      { width: 20_000, height: 1000 },
      { width: 1200, height: 800 },
    ],
  ])('shows all of an image %s', (_label, image, room) => {
    const fit = fitZoom({ image, room });
    expect(image.width * fit).toBeLessThanOrEqual(room.width);
    expect(image.height * fit).toBeLessThanOrEqual(room.height);
  });
});
