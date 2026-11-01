// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { parseObjectType } from '@dfai/domain';
import { fakeIndexPort } from '@dfai/application';
import { useAtlasQuery } from './use-atlas-query.ts';

const TYPES = [parseObjectType({ name: 'task', properties: {} })];
const NO_NOTES: readonly string[] = [];

function queryEditor() {
  const limits: unknown[] = [];
  const index = fakeIndexPort({
    query: async (_sql, parameters) => {
      limits.push(parameters.at(-1));
      return { columns: ['path', 'title', 'type'], rows: [], truncated: false };
    },
  });
  const hook = renderHook(() =>
    useAtlasQuery({
      initialText: 'FROM task',
      index,
      types: TYPES,
      notePaths: NO_NOTES,
      indexKey: 'ready',
    }),
  );
  return { hook, limits };
}

describe('useAtlasQuery while the text is typed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the query once typing pauses, not on every keystroke', async () => {
    const { hook, limits } = queryEditor();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(limits).toHaveLength(1);

    for (const text of ['FROM task LIMIT 1', 'FROM task LIMIT 12', 'FROM task LIMIT 123']) {
      act(() => hook.result.current.setText(text));
      await act(() => vi.advanceTimersByTimeAsync(50));
    }
    expect(hook.result.current.text).toBe('FROM task LIMIT 123');
    expect(limits).toHaveLength(1);

    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(limits).toHaveLength(2);
    expect(limits.at(-1)).toBe(123);
  });

  it('runs a query the builder made at once', async () => {
    const { hook, limits } = queryEditor();
    await act(() => vi.advanceTimersByTimeAsync(0));
    const builder = hook.result.current.builder;
    if (builder === null) throw new Error('the builder should be open over FROM task');
    act(() => hook.result.current.setBuilder({ ...builder, limit: 7 }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(limits.at(-1)).toBe(7);
  });
});
