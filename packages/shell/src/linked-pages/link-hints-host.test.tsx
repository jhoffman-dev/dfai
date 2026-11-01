// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { LINK_HINTS_QUERY_COLUMNS } from '@dfai/domain';
import type { IndexPort } from '@dfai/application';
import { useLinkHints, type LinkHintsSource } from '@dfai/ui';
import { createIndexStatusStore } from '../index/index-status-store.ts';
import { LinkHintsHost } from './link-hints-host.tsx';

afterEach(cleanup);

const ROWS = [
  ['note', 'People/Mara Quill.md', 'Mara Quill', null, null],
  ['alias', 'People/Mara Quill.md', 'MQ', null, null],
];

function host({ query }: { query: IndexPort['query'] }) {
  const status = createIndexStatusStore();
  status.setState({ vault: '/v', phase: 'ready', revision: 1 });
  const seen: { current: LinkHintsSource | null } = { current: null };
  let drawn = 0;
  function Picker() {
    seen.current = useLinkHints();
    return null;
  }
  function Page() {
    drawn += 1;
    return <Picker />;
  }
  const view = render(
    <LinkHintsHost index={{ query }} status={status} vault="/v">
      <Page />
    </LinkHintsHost>,
  );
  return { status, seen, view, drawnPage: () => drawn };
}

/** A read is three queries, one per part: notes, aliases and use. */
const PER_READ = 3;

const answering = (rows: unknown[][] = ROWS) =>
  vi.fn<IndexPort['query']>(async () => ({
    columns: [...LINK_HINTS_QUERY_COLUMNS],
    rows,
    truncated: false,
  }));

describe('LinkHintsHost', () => {
  it('reads nothing until a picker wants it, then the notes and their aliases', async () => {
    const query = answering();
    const { seen } = host({ query });
    expect(query).not.toHaveBeenCalled();
    expect(seen.current?.notes).toBeNull();
    await act(async () => seen.current?.want());
    expect(query).toHaveBeenCalledTimes(PER_READ);
    expect(seen.current?.notes).toEqual([{ path: 'People/Mara Quill.md', title: 'Mara Quill' }]);
    expect(seen.current?.hints.aliases.get('People/Mara Quill.md')).toEqual(['MQ']);
  });

  it('draws the page under it no more when what it read lands', async () => {
    const { seen, drawnPage } = host({ query: answering() });
    const before = drawnPage();
    await act(async () => seen.current?.want());
    expect(drawnPage()).toBe(before);
  });

  it('reads once for the index as it is, and again once the index has moved on', async () => {
    const query = answering();
    const { seen, status } = host({ query });
    await act(async () => seen.current?.want());
    await act(async () => seen.current?.want());
    expect(query).toHaveBeenCalledTimes(PER_READ);
    act(() => status.setState({ revision: 2 }));
    // News from the index alone reads nothing: only the next opening does.
    expect(query).toHaveBeenCalledTimes(PER_READ);
    await act(async () => seen.current?.want());
    expect(query).toHaveBeenCalledTimes(2 * PER_READ);
  });

  it('asks once while a read is under way', async () => {
    const waiting: (() => void)[] = [];
    const finish = () => waiting.forEach((resolve) => resolve());
    const query = vi.fn<IndexPort['query']>(
      () =>
        new Promise((resolve) => {
          waiting.push(() =>
            resolve({ columns: [...LINK_HINTS_QUERY_COLUMNS], rows: ROWS, truncated: false }),
          );
        }),
    );
    const { seen } = host({ query });
    act(() => {
      seen.current?.want();
      seen.current?.want();
    });
    await act(async () => finish());
    expect(query).toHaveBeenCalledTimes(PER_READ);
  });

  it('says why it could not read, and tries again on the next opening', async () => {
    const query = vi
      .fn<IndexPort['query']>()
      .mockRejectedValueOnce(new Error('The index is busy.'))
      .mockRejectedValueOnce(new Error('The index is busy.'))
      .mockRejectedValueOnce(new Error('The index is busy.'))
      .mockResolvedValue({ columns: [...LINK_HINTS_QUERY_COLUMNS], rows: ROWS, truncated: false });
    const { seen } = host({ query });
    await act(async () => seen.current?.want());
    expect(seen.current?.problem).toContain('The index is busy.');
    await act(async () => seen.current?.want());
    expect(seen.current?.problem).toBeNull();
    expect(seen.current?.notes).toHaveLength(1);
  });
});
