// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { parseObjectType, type LinkedRange, type LinkedSectionId } from '@dfai/domain';
import type { IndexPort, LinkedRangeStore, QueryResult } from '@dfai/application';
import { useLinkedPage } from './use-linked-page.ts';

/** Adversarial pass on the linked-page hook (P30-06, PR #117). */
const TYPES = [
  parseObjectType({ name: 'person', label: 'Person', properties: {} }),
  parseObjectType({
    name: 'meeting',
    label: 'Meeting',
    properties: { date: 'date', people: { kind: 'relation', target: 'person', many: true } },
  }),
];
const MARA = 'People/Mara Quill.md';
const NOTES = [MARA, 'Meetings/Kickoff.md'];

type Ranges = Partial<Record<LinkedSectionId, LinkedRange>>;

function memoryStore(seed: Record<string, Ranges> = {}): LinkedRangeStore {
  const held = new Map(Object.entries(seed));
  return {
    read: (pageType) => held.get(pageType) ?? {},
    write: (pageType, section, range) => {
      held.set(pageType, { ...held.get(pageType), [section]: range });
    },
  };
}

/** An index that answers one row a query, at once or — once held — when released. */
function heldIndex() {
  const pending: (() => void)[] = [];
  let held = false;
  const answer: QueryResult = {
    columns: ['path', 'title', 'type'],
    rows: [['Meetings/Kickoff.md', 'Kickoff', 'meeting']],
    truncated: false,
  };
  const query: IndexPort['query'] = () =>
    held ? new Promise((resolve) => pending.push(() => resolve(answer))) : Promise.resolve(answer);
  return {
    index: { query } as IndexPort,
    hold: () => {
      held = true;
    },
    release: () => pending.splice(0).forEach((resolve) => resolve()),
  };
}

interface PaneProps {
  typeName: string | null;
}

function mount(typeName: string, store: LinkedRangeStore = memoryStore()) {
  const index = heldIndex();
  const hook = renderHook(
    (props: PaneProps) =>
      useLinkedPage({
        index: index.index,
        clock: { today: () => '2026-10-13' },
        store,
        types: TYPES,
        notePaths: NOTES,
        notePath: MARA,
        revision: '1',
        ...props,
      }),
    { initialProps: { typeName } },
  );
  return { ...hook, index };
}

describe('useLinkedPage under attack', () => {
  // What was read is remembered by path alone. Retype the open note (the
  // type picker, or `type:` edited in its properties) and the old type's
  // sections stay under the new type until the new read lands — and for
  // good if that read fails.
  it('never shows one type’s sections on the page once it is another type', async () => {
    const { result, rerender, index } = mount('person');
    await waitFor(() => expect(result.current?.sections).not.toBeNull());
    expect(result.current?.sections?.map((section) => section.id)).toEqual(['meetings', 'notes']);
    index.hold();
    rerender({ typeName: 'meeting' });
    // A meeting's page has People here; a person's Meetings and Linked notes are not its own.
    expect(result.current?.sections ?? []).toEqual([]);
    await act(async () => index.release());
    await waitFor(() =>
      expect(result.current?.sections?.map((section) => section.id)).toEqual(['people']),
    );
  });

  // A page is a linked page whatever case its `type:` is in, but the range
  // is stored and read under the type exactly as the note spells it.
  it('opens a section on the range left for its type, however the note cases the type', async () => {
    const store = memoryStore({ person: { meetings: 'all' } });
    const { result } = mount('Person', store);
    await waitFor(() => expect(result.current?.sections).not.toBeNull());
    expect(result.current?.sections?.find((section) => section.id === 'meetings')?.range).toBe(
      'all',
    );
  });
});
