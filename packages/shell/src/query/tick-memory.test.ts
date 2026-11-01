// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { VaultPath } from '@dfai/domain';
import { renderHook } from '@testing-library/react';
import { createTickMemory, useTickMemory } from './tick-memory.ts';

const path = (text: string) => text as VaultPath;

describe('tick memory', () => {
  it('recalls what a note held before its tick', () => {
    const memory = createTickMemory();
    memory.remember({ path: 'Tasks/a.md', value: 'review' });
    expect(memory.recall('Tasks/a.md')).toBe('review');
    expect(memory.recall('Tasks/b.md')).toBeNull();
  });

  it('follows a note that is renamed, and every note in a folder that is moved', () => {
    const memory = createTickMemory();
    memory.remember({ path: 'Tasks/a.md', value: 'review' });
    memory.remember({ path: 'Tasks/Sub/b.md', value: 'doing' });
    memory.remember({ path: 'Tasks Old/c.md', value: 'next' });

    memory.follow({ from: path('Tasks/a.md'), to: path('Tasks/renamed.md') });
    expect(memory.recall('Tasks/a.md')).toBeNull();
    expect(memory.recall('Tasks/renamed.md')).toBe('review');

    memory.follow({ from: path('Tasks'), to: path('Archive/Tasks') });
    expect(memory.recall('Archive/Tasks/renamed.md')).toBe('review');
    expect(memory.recall('Archive/Tasks/Sub/b.md')).toBe('doing');
    // Only starts with the same name: not under the folder moved.
    expect(memory.recall('Tasks Old/c.md')).toBe('next');
  });
});

describe('useTickMemory', () => {
  it('keeps one memory while the vault stays, and starts afresh in another', () => {
    const { result, rerender } = renderHook(({ vault }) => useTickMemory(vault), {
      initialProps: { vault: '/vaults/work' as string | null },
    });
    result.current.remember({ path: 'Tasks/a.md', value: 'review' });
    rerender({ vault: '/vaults/work' });
    expect(result.current.recall('Tasks/a.md')).toBe('review');
    rerender({ vault: '/vaults/home' });
    expect(result.current.recall('Tasks/a.md')).toBeNull();
  });
});
