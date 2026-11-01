import { describe, expect, it } from 'vitest';
import { createOwnWrites } from '@dfai/application';
import { tellingOwnWrites } from './telling-own-writes.ts';

describe('the app’s own writes, telling where each landed', () => {
  it('tells of a write kept and a write forgotten, and keeps them as before', () => {
    const told: string[] = [];
    const inner = createOwnWrites({ clock: { now: () => 1000 } });
    const writes = tellingOwnWrites(inner, ({ vault, path }) => told.push(`${vault}:${path}`));
    const file = { vault: '/v', path: '.atlas/templates/Book.md' };

    writes.record({ ...file, left: { kind: 'text', text: 'x', modified: 1 } });
    expect(inner.leftAt(file)).toEqual({ kind: 'text', text: 'x', modified: 1 });
    writes.forget(file);

    expect(told).toEqual(['/v:.atlas/templates/Book.md', '/v:.atlas/templates/Book.md']);
    expect(writes.leftAt(file)).toBeNull();
  });
});
