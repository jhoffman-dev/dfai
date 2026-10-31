// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { useEffect, useRef } from 'react';
import { renderHook } from '@testing-library/react';
import { createVaultPath, type VaultPath } from '@dfai/domain';
import { useRowHandles } from './row-handles.ts';

const KEPT = createVaultPath('Inbox/Fix the gate.md');
const BACK = createVaultPath('Inbox/Call the bank.md');

/**
 * Another hook on the page whose effect asks for a row in the commit that
 * lists it — as an undo's focus-on-return does — declared before the
 * handles, so its effect runs first.
 */
function useFocusAsListed(order: readonly VaultPath[], path: VaultPath) {
  const focusRow = useRef<((path: VaultPath) => void) | null>(null);
  useEffect(() => {
    if (order.includes(path)) focusRow.current?.(path);
  }, [order, path]);
  const handles = useRowHandles(order);
  focusRow.current = handles.focusRow;
  return handles;
}

describe('useRowHandles', () => {
  it('wants a row asked for in the commit that lists it, before the list has drawn it', () => {
    const hook = renderHook(({ order }) => useFocusAsListed(order, BACK), {
      initialProps: { order: [KEPT] as readonly VaultPath[] },
    });
    expect(hook.result.current.wanted).toBeNull();

    hook.rerender({ order: [BACK, KEPT] });

    expect(hook.result.current.wanted).toBe(BACK);
  });
});
