import { useEffect } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';
import type { EditorDocument, TabId, VaultPath } from '@dfai/domain';
import type { BacklinksPane, PropertiesPanel } from '@dfai/ui';

type PanelProps = Parameters<typeof PropertiesPanel>[0];
type BacklinksProps = Parameters<typeof BacklinksPane>[0];

/**
 * What a note tab shows, as the aside needs it: the properties as the page's
 * own panel draws them (so the aside's rows write through the same
 * `onChange`, with the same commit rules) and the links. The document is
 * published apart (`publishShownDoc`): it changes with every keystroke, and
 * only the Outline reads it.
 */
export interface ShownNote {
  readonly path: VaultPath;
  readonly title: string;
  /** What the aside's kicker says the note is: its type's label, or "Note". */
  readonly kicker: string;
  readonly panel: Omit<PanelProps, 'folded'>;
  readonly links: BacklinksProps['links'];
  readonly mentions: BacklinksProps['mentions'];
  readonly onFindMentions: BacklinksProps['onFindMentions'];
  readonly onLinkMention: BacklinksProps['onLinkMention'];
  /** Given for a person: "Merge into…" at the foot of their properties (#464). */
  readonly onMergeInto?: () => void;
}

interface ShownNotesState {
  readonly byTab: ReadonlyMap<TabId, ShownNote>;
  readonly docByTab: ReadonlyMap<TabId, EditorDocument>;
}

/**
 * Each note tab's say of what it shows, keyed by tab, so the aside reads the
 * tab it follows through a selector rather than through props from `App`
 * (#306). A tab publishes as its note loads and as its properties change, and
 * withdraws as it unmounts; nothing subscribes while the aside is shut, so a
 * publish then costs no draw.
 */
export type ShownNotes = StoreApi<ShownNotesState>;

export function createShownNotes(): ShownNotes {
  return createStore<ShownNotesState>()(() => ({ byTab: new Map(), docByTab: new Map() }));
}

export function publishShownNote(store: ShownNotes, tab: TabId, shown: ShownNote | null): void {
  const { byTab } = store.getState();
  if (byTab.get(tab) === (shown ?? undefined)) return;
  store.setState({ byTab: replaced(byTab, tab, shown) });
}

export function publishShownDoc(store: ShownNotes, tab: TabId, doc: EditorDocument | null): void {
  const { docByTab } = store.getState();
  if (docByTab.get(tab) === (doc ?? undefined)) return;
  store.setState({ docByTab: replaced(docByTab, tab, doc) });
}

function replaced<Value>(
  held: ReadonlyMap<TabId, Value>,
  tab: TabId,
  value: Value | null,
): Map<TabId, Value> {
  const next = new Map(held);
  if (value === null) next.delete(tab);
  else next.set(tab, value);
  return next;
}

export function useShownNote(store: ShownNotes, tab: TabId): ShownNote | null {
  return useStore(store, (state) => state.byTab.get(tab) ?? null);
}

export function useShownDoc(store: ShownNotes, tab: TabId): EditorDocument | null {
  return useStore(store, (state) => state.docByTab.get(tab) ?? null);
}

/**
 * Publishes a tab's note and its document after each render that changed
 * either, and withdraws both as the tab unmounts. The caller memoises
 * `shown` on what the aside's Properties and Backlinks read, so a keystroke
 * publishes the document and nothing else draws for it.
 */
export function usePublishShownNote(
  store: ShownNotes,
  tab: TabId,
  { shown, doc }: { shown: ShownNote | null; doc: EditorDocument | null },
): void {
  useEffect(() => {
    publishShownNote(store, tab, shown);
  }, [store, tab, shown]);
  useEffect(() => {
    publishShownDoc(store, tab, doc);
  }, [store, tab, doc]);
  useEffect(
    () => () => {
      publishShownNote(store, tab, null);
      publishShownDoc(store, tab, null);
    },
    [store, tab],
  );
}
