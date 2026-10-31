// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createVaultPath, NO_LINKS, type EditorDocument } from '@dfai/domain';
import {
  createShownNotes,
  publishShownDoc,
  publishShownNote,
  usePublishShownNote,
  useShownDoc,
  useShownNote,
  type ShownNote,
} from './shown-notes.ts';

const DOC: EditorDocument = { type: 'doc', content: [] };
const DOC_B: EditorDocument = { type: 'doc', content: [{ type: 'paragraph' }] };

const shown = (name: string): ShownNote => ({
  path: createVaultPath(`${name}.md`),
  title: name,
  kicker: 'Note',
  panel: { typeName: null, rows: [], relationChoices: {}, onChange: vi.fn() },
  links: NO_LINKS,
  mentions: { kind: 'idle' },
  onFindMentions: vi.fn(),
  onLinkMention: vi.fn(),
});

describe('the shown notes', () => {
  it('holds what each tab says, read by the tab', () => {
    const store = createShownNotes();
    const a = shown('a');
    publishShownNote(store, 't1', a);
    publishShownNote(store, 't2', shown('b'));
    const { result } = renderHook(() => useShownNote(store, 't1'));
    expect(result.current).toBe(a);
    expect(store.getState().byTab.get('t2')?.title).toBe('b');
  });

  it('a tab withdrawing leaves the others', () => {
    const store = createShownNotes();
    publishShownNote(store, 't1', shown('a'));
    publishShownNote(store, 't2', shown('b'));
    publishShownNote(store, 't1', null);
    expect(store.getState().byTab.has('t1')).toBe(false);
    expect(store.getState().byTab.get('t2')?.title).toBe('b');
  });

  it('publishing the same say again changes nothing', () => {
    const store = createShownNotes();
    const a = shown('a');
    publishShownNote(store, 't1', a);
    const before = store.getState();
    publishShownNote(store, 't1', a);
    expect(store.getState()).toBe(before);
    publishShownNote(store, 't2', null);
    expect(store.getState()).toBe(before);
  });

  it('the hook publishes as the say changes and withdraws as the tab unmounts', () => {
    const store = createShownNotes();
    const a = shown('a');
    const { rerender, unmount } = renderHook(
      ({ say }: { say: ShownNote | null }) =>
        usePublishShownNote(store, 't1', { shown: say, doc: DOC }),
      { initialProps: { say: a as ShownNote | null } },
    );
    expect(store.getState().byTab.get('t1')).toBe(a);
    expect(store.getState().docByTab.get('t1')).toBe(DOC);
    const b = shown('b');
    rerender({ say: b });
    expect(store.getState().byTab.get('t1')).toBe(b);
    rerender({ say: null });
    expect(store.getState().byTab.has('t1')).toBe(false);
    rerender({ say: a });
    unmount();
    expect(store.getState().byTab.has('t1')).toBe(false);
    expect(store.getState().docByTab.has('t1')).toBe(false);
  });

  it('a new document draws the document’s reader, not the note’s', () => {
    const store = createShownNotes();
    publishShownNote(store, 't1', shown('a'));
    publishShownDoc(store, 't1', DOC);
    const noteDraws = vi.fn();
    const docDraws = vi.fn();
    renderHook(() => {
      noteDraws();
      return useShownNote(store, 't1');
    });
    const { result } = renderHook(() => {
      docDraws();
      return useShownDoc(store, 't1');
    });
    act(() => publishShownDoc(store, 't1', DOC_B));
    expect(result.current).toBe(DOC_B);
    expect(docDraws).toHaveBeenCalledTimes(2);
    expect(noteDraws).toHaveBeenCalledTimes(1);
  });

  it('a reader of one tab is not drawn for another tab’s say', () => {
    const store = createShownNotes();
    const a = shown('a');
    publishShownNote(store, 't1', a);
    const draws = vi.fn();
    renderHook(() => {
      draws();
      return useShownNote(store, 't1');
    });
    expect(draws).toHaveBeenCalledTimes(1);
    publishShownNote(store, 't2', shown('b'));
    expect(draws).toHaveBeenCalledTimes(1);
  });
});
