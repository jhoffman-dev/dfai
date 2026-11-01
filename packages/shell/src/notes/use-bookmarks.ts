import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  missingBookmark,
  type BookmarkCard,
  type ObjectType,
  type VaultPath,
  type WikiLink,
} from '@dfai/domain';
import {
  createBookmarkReader,
  type BookmarkReader,
  type IndexPort,
  type MarkdownPort,
  type VaultFsPort,
} from '@dfai/application';
import type { BookmarkPreview, NoteBookmarks } from '@dfai/ui';
import { useVaultImages } from './use-images.ts';

type LoadPicture = (args: { path: string; src: string }) => Promise<string | null>;
type NoteCard = Extract<BookmarkCard, { kind: 'note' }>;

/** Where the cards are, as the page has it now. */
interface CardPlace {
  readonly notePath: VaultPath | null;
  readonly notePaths: readonly VaultPath[];
  readonly types: readonly ObjectType[];
}

/** A card asked for, waiting for the read that answers every card asked for with it. */
interface PendingCard {
  readonly link: WikiLink;
  readonly settle: (card: Promise<BookmarkPreview>) => void;
}

/**
 * Where a note's bookmark cards read the notes they open (U-21): the linked
 * note's file, and the first of its pictures that loads — each resolved
 * against that note, not the one the card is in.
 *
 * Every card asks again whenever `revision` — the index's count of changes —
 * moves, but the cards asked for together are read together, and a card is
 * read from its file again only when the note it opens has changed (A22-01).
 * Its picture is kept with it, and let go when the card is read anew.
 */
export function useBookmarks({
  fs,
  markdown,
  index,
  notePath,
  notePaths,
  types,
  revision,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  /** Says which notes changed since a card was read. */
  index: IndexPort;
  /** The note the cards are in: its pictures are let go when it closes. */
  notePath: VaultPath | null;
  notePaths: readonly VaultPath[];
  types: readonly ObjectType[];
  revision: string;
}): NoteBookmarks {
  const loadPicture = useVaultImages({ fs, resetKey: notePath });
  // Types are read again on every change to the vault; a card is read again only when they differ.
  const typesKey = useMemo(() => JSON.stringify(types), [types]);
  const reader = useMemo(
    () => createBookmarkReader({ fs, markdown, index }),
    // A new note, or new types (typesKey stands for them), starts the cards afresh.
    [fs, markdown, index, notePath, typesKey],
  );
  const place = useRef<CardPlace>({ notePath, notePaths, types });
  place.current = { notePath, notePaths, types };
  const previews = usePreviews({ loadPicture, resetKey: reader });
  const readTogether = useBatchedRead({ reader, place, previews });
  return useMemo(() => ({ load: readTogether, revision }), [readTogether, revision]);
}

/**
 * `load` for each card, answered in one read of every card asked for in the
 * same turn — as all of a note's cards are, when it opens or the vault changes.
 */
function useBatchedRead({
  reader,
  place,
  previews,
}: {
  reader: BookmarkReader;
  place: { readonly current: CardPlace };
  previews: (card: BookmarkCard) => Promise<BookmarkPreview>;
}): (link: WikiLink) => Promise<BookmarkPreview> {
  const pending = useRef<PendingCard[]>([]);

  const flush = useCallback(() => {
    const asked = pending.current;
    pending.current = [];
    const { notePath, notePaths, types } = place.current;
    const cards =
      notePath === null
        ? Promise.reject(new Error('Bookmarks are read in a note.'))
        : reader.read({
            links: asked.map(({ link }) => link),
            holder: notePath,
            notePaths,
            typeOf: (name) => types.find((candidate) => candidate.name === name),
          });
    asked.forEach(({ link, settle }, at) =>
      settle(cards.then((read) => previews(read[at] ?? missingBookmark(link)))),
    );
  }, [reader, place, previews]);

  return useCallback(
    (link: WikiLink) =>
      new Promise<BookmarkPreview>((resolve, reject) => {
        if (pending.current.length === 0) queueMicrotask(flush);
        pending.current.push({ link, settle: (card) => card.then(resolve, reject) });
      }),
    [flush],
  );
}

/**
 * The card as the page draws it, made once per card read: its first picture
 * that loads, ready to show. When a note's card is read anew, the pictures of
 * its last one are let go; the rest go when `resetKey` changes or the page does.
 */
function usePreviews({
  loadPicture,
  resetKey,
}: {
  loadPicture: LoadPicture;
  resetKey: unknown;
}): (card: BookmarkCard) => Promise<BookmarkPreview> {
  const made = useRef(new WeakMap<NoteCard, Promise<BookmarkPreview>>());
  // The blob URLs each note's card is drawn with now, by the note's path.
  const shown = useRef(new Map<string, string[]>());

  useEffect(() => {
    const kept = shown.current;
    return () => {
      for (const urls of kept.values()) urls.forEach((url) => URL.revokeObjectURL(url));
      kept.clear();
    };
  }, [resetKey]);

  return useCallback(
    (card: BookmarkCard) => {
      if (card.kind === 'missing') return Promise.resolve(card);
      const known = made.current.get(card);
      if (known !== undefined) return known;
      shown.current.get(card.path)?.forEach((url) => URL.revokeObjectURL(url));
      const urls: string[] = [];
      shown.current.set(card.path, urls);
      const preview = previewOf(card, async (args) => {
        const url = await loadPicture(args);
        if (url?.startsWith('blob:') === true) urls.push(url);
        return url;
      });
      made.current.set(card, preview);
      return preview;
    },
    [loadPicture],
  );
}

/** The card as the page draws it: its first picture that loads, ready to show. */
async function previewOf(card: NoteCard, loadPicture: LoadPicture): Promise<BookmarkPreview> {
  const { title, summary, place, archived } = card;
  return {
    kind: 'note',
    title,
    summary,
    place,
    archived,
    picture: await firstPicture(card, loadPicture),
  };
}

async function firstPicture(card: NoteCard, loadPicture: LoadPicture): Promise<string | null> {
  for (const src of card.pictures) {
    const url = await loadPicture({ path: card.path, src });
    if (url !== null) return url;
  }
  return null;
}
