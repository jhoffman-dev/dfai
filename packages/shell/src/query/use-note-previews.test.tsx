// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { BoardRow, ViewLayout } from '@dfai/domain';
import { fakeVaultFs, PREVIEW_BATCH } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { FEED_PAGE, GALLERY_COVERS, useNotePreviews } from './use-note-previews.ts';

const rows: BoardRow[] = Array.from({ length: 60 }, (_, at) => ({
  path: `${at}.md`,
  title: `Note ${at}`,
  values: {},
}));

/** A vault whose every note reads as its own name, recording what was asked for. */
function vault() {
  const asked: string[][] = [];
  const fs = fakeVaultFs({
    readNotes: async (paths) => {
      asked.push([...paths]);
      return paths.map((path) => ({ path, text: `Body of ${path}\n`, modified: 1, size: 1 }));
    },
  });
  return { fs, asked };
}

function show(fs: ReturnType<typeof vault>['fs'], layout: ViewLayout, indexKey = 'ready:1') {
  return renderHook(
    (props: { layout: ViewLayout; indexKey: string; viewKey: string }) =>
      useNotePreviews({ fs, markdown: remarkMarkdown, rows, type: null, ...props }),
    { initialProps: { layout, indexKey, viewKey: 'Feed.md' } },
  );
}

describe('useNotePreviews', () => {
  it('reads nothing for a layout that shows no bodies', async () => {
    const { fs, asked } = vault();
    show(fs, 'table');
    await act(async () => {});
    expect(asked).toEqual([]);
  });

  it('reads a feed’s first page of bodies, and the next on Show more', async () => {
    const { fs, asked } = vault();
    const view = show(fs, 'feed');
    await waitFor(() => expect(view.result.current.bodies.bodyOf('0.md')).toBeDefined());
    expect(asked.flat()).toHaveLength(FEED_PAGE);
    expect(view.result.current.bodies.bodyOf(`${FEED_PAGE}.md`)).toBeUndefined();

    act(() => view.result.current.showMore());
    expect(view.result.current.shown).toBe(2 * FEED_PAGE);
    await waitFor(() => expect(view.result.current.bodies.bodyOf(`${FEED_PAGE}.md`)).toBeDefined());
  });

  it('reads a gallery’s covers a batch at a time, up to its cap', async () => {
    const { fs, asked } = vault();
    const view = show(fs, 'gallery');
    await waitFor(() => expect(asked.flat()).toHaveLength(GALLERY_COVERS));
    expect(asked.every((batch) => batch.length <= PREVIEW_BATCH)).toBe(true);
    expect(view.result.current.covers.coverOf('0.md')).toBeNull();
  });

  it('reads again when the index says a note changed', async () => {
    const { fs, asked } = vault();
    const view = show(fs, 'feed');
    await waitFor(() => expect(asked).toHaveLength(1));
    view.rerender({ layout: 'feed', indexKey: 'ready:2', viewKey: 'Feed.md' });
    await waitFor(() => expect(asked).toHaveLength(2));
  });

  it('starts a different view from its first page', async () => {
    const { fs } = vault();
    const view = show(fs, 'feed');
    act(() => view.result.current.showMore());
    expect(view.result.current.shown).toBe(2 * FEED_PAGE);
    view.rerender({ layout: 'feed', indexKey: 'ready:1', viewKey: 'Other.md' });
    expect(view.result.current.shown).toBe(FEED_PAGE);
  });

  describe('when the rows say when each note last changed', () => {
    const dated = (modified: number): BoardRow[] =>
      rows.map((row) => ({ ...row, values: { modified } }));

    function showDated(fs: ReturnType<typeof vault>['fs']) {
      return renderHook(
        (props: { rows: BoardRow[]; indexKey: string }) =>
          useNotePreviews({
            fs,
            markdown: remarkMarkdown,
            layout: 'feed',
            viewKey: 'Feed.md',
            type: null,
            ...props,
          }),
        { initialProps: { rows: dated(1), indexKey: 'ready:1' } },
      );
    }

    // Every save anywhere moves the index on; a feed whose notes did not
    // change must not read them all again.
    it('reads nothing again when the index moves on but its notes did not change', async () => {
      const { fs, asked } = vault();
      const view = showDated(fs);
      await waitFor(() => expect(asked).toHaveLength(1));
      view.rerender({ rows: dated(1), indexKey: 'ready:2' });
      await act(async () => {});
      expect(asked).toHaveLength(1);
    });

    it('reads again when one of its notes changed', async () => {
      const { fs, asked } = vault();
      const view = showDated(fs);
      await waitFor(() => expect(asked).toHaveLength(1));
      const changed = dated(1).map((row, at) =>
        at === 0 ? { ...row, values: { modified: 2 } } : row,
      );
      view.rerender({ rows: changed, indexKey: 'ready:2' });
      await waitFor(() => expect(asked).toHaveLength(2));
    });
  });
});
