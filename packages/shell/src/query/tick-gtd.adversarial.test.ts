/**
 * Adversarial pass on P30-02, acceptance criterion "unticking restores the
 * prior status": a task ticked off, the app quit and opened again, then
 * unticked. What it held before the tick lives only in this session's
 * memory, so the second session cannot put it back.
 */
import { describe, expect, it } from 'vitest';
import { GTD_STATUS_PROPERTY, statusToRemember, type StatusProperty } from '@dfai/domain';
import { doneChange } from '@dfai/application';
import { createTickMemory } from './tick-memory.ts';

const STATUS: StatusProperty = {
  key: GTD_STATUS_PROPERTY.key,
  done: GTD_STATUS_PROPERTY.done ?? 'archive',
  options: GTD_STATUS_PROPERTY.options,
};
const path = 'tasks/Call Tobias.md';

describe('unticking a GTD task after the app was opened again', () => {
  it('puts back the status it held before it was ticked', () => {
    const before = createTickMemory();
    const kept = statusToRemember({ status: STATUS, value: 'next-action' });
    if (kept !== null) before.remember({ path, value: kept });

    const afterRestart = createTickMemory();
    const untick = doneChange({
      status: STATUS,
      done: false,
      previous: afterRestart.recall(path),
    });
    expect(untick).toEqual({ status: 'next-action' });
  });
});
