// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import { TableView, type TableResult } from '@dfai/ui';
import { startCountingRenders, stopCountingRenders, tableRowsMeasured } from '@dfai/ui/testing';
import {
  createAsideStore,
  focusRow,
  showAsideTab,
  useAsideOpen,
  useAsideTab,
  type AsideStore,
} from './aside-store.ts';

await vi.hoisted(async () => {
  const { installRenderCounter } = await import('@dfai/ui/testing');
  installRenderCounter();
});

// Attack pass on PR #387: focusing rows quickly draws no row, and no table, again.

afterEach(cleanup);

const ROWS = 40;
const RESULT: TableResult = {
  columns: ['path', 'title', 'status'],
  rows: Array.from({ length: ROWS }, (_, at) => [`People/p${at}.md`, `Person ${at}`, 'doing']),
  truncated: false,
  sql: '',
};

/** What the type page does: an inline handler each render, told to the aside's store. */
function TypeTable({ aside }: { aside: AsideStore }) {
  // A reader of what the app reads beside the table: open and tab, never the rows.
  useAsideOpen(aside);
  useAsideTab(aside);
  return (
    <TableView
      result={RESULT}
      sorts={[]}
      error={null}
      schema={{ kinds: { status: 'select' }, labels: {}, noun: 'Person' }}
      onOpenNote={() => {}}
      onEditCell={() => {}}
      onToggleSort={() => {}}
      onRowFocus={(path) =>
        focusRow(aside, { tab: 't1', path: createVaultPath(path), within: 'type:person' })
      }
    />
  );
}

describe('the table under a following aside (attack #387)', () => {
  tableRowsMeasured();

  it('guard: focusing twenty rows in a row draws no TableRow and no TableView again', () => {
    const aside = createAsideStore({ remembered: { read: () => null, write: () => {} } });
    showAsideTab(aside, 'properties');
    render(<TypeTable aside={aside} />);
    const names = screen.getAllByRole('button', { name: /^Person \d+$/ });
    expect(names.length).toBeGreaterThanOrEqual(20);

    startCountingRenders();
    act(() => {
      for (const name of names.slice(0, 20)) name.focus();
    });
    const { renders } = stopCountingRenders();

    expect(aside.getState().rows.get('t1')?.path).toBe('People/p19.md');
    expect(renders['TableRow'] ?? 0).toBe(0);
    expect(renders['TableView'] ?? 0).toBe(0);
    expect(renders['TypeTable'] ?? 0).toBe(0);
  });

  it('guard: focusing the row already held writes nothing to the store', () => {
    const aside = createAsideStore({ remembered: { read: () => null, write: () => {} } });
    render(<TypeTable aside={aside} />);
    const first = screen.getByRole('button', { name: 'Person 0' });
    act(() => first.focus());
    const held = aside.getState().rows;
    act(() => {
      first.blur();
      first.focus();
    });
    expect(aside.getState().rows).toBe(held);
  });
});
