import { describe, expect, it } from 'vitest';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { PointerSensor } from '@dnd-kit/core';
import { FinePointerSensor } from './dnd.ts';

const press = (pointerType: string, button = 0) =>
  ({ nativeEvent: { pointerType, button, isPrimary: true } }) as unknown as ReactPointerEvent;

const activator = FinePointerSensor.activators[0];
if (activator === undefined) throw new Error('The sensor has no activator.');

describe('FinePointerSensor', () => {
  it('takes a mouse or a pen press exactly as dnd-kit’s own pointer sensor does', () => {
    const own = PointerSensor.activators[0];
    if (own === undefined) throw new Error('dnd-kit’s sensor has no activator.');
    for (const event of [press('mouse'), press('pen'), press(''), press('mouse', 2)]) {
      expect(activator.handler(event, {})).toBe(own.handler(event, {}));
    }
    expect(activator.handler(press('mouse'), {})).toBe(true);
  });

  it('leaves a finger to the touch sensor', () => {
    expect(activator.handler(press('touch'), {})).toBe(false);
  });
});
