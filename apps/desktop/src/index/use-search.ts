import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  matchingCommands,
  messageWithoutPaths,
  toSearchQuery,
  type PaletteCommand,
} from '@dfai/domain';
import { searchNotes, type BuildProgress, type IndexPort, type SearchHit } from '@dfai/application';
import { withArchived, withMeaning, withMoved, withQuery } from '../overlay.ts';
import { changePalette, usePaletteInput, type OverlayStore } from '../overlay-store.ts';
import { useSemanticKey, type MeaningSource } from '../semantic/use-semantic-key.ts';

const LIMIT = 20;
/**
 * By meaning, two blocks of a note with no id open the same place and are one row:
 * three times the rows are asked for, so the rows left once they are one still fill the list.
 */
const MEANING_ASKED = LIMIT * 3;
/** How long a question by meaning waits for the next key before the model is asked. */
const MEANING_TYPING_MS = 150;

const NO_COMMANDS: readonly PaletteCommand[] = [];
const NO_HITS: readonly SearchHit[] = [];
/** Hits, and the search they answered: `includeArchived:mode:query`. */
interface Answer {
  readonly asked: string;
  readonly hits: readonly SearchHit[];
  /** By meaning: how far the cache was built as it answered, or why it could not. */
  readonly meaning?: MeaningStatus;
}
const NO_ANSWER: Answer = { asked: '', hits: NO_HITS };

/** How a search by meaning stands, for the palette to say. */
export interface MeaningStatus {
  readonly progress: BuildProgress | null;
  /** Why the search could not run — the model could not be fetched, say. */
  readonly problem: string | null;
}
/**
 * The index being built — a vault's first sync, or a rebuild: searched now, it
 * answers from half of it (#135). A refresh keeps the index ready (#238).
 */
const BUILDING = 'building';
const noOffers = (): readonly PaletteCommand[] => NO_COMMANDS;

/**
 * Runs a search as the query changes, keeping the selected result in range.
 * The commands the query names come first, and the arrow keys move through
 * them and the notes as one list.
 */
export function useSearch({
  index,
  commands = NO_COMMANDS,
  offerFor = noOffers,
  changeKey,
  store,
  semantic,
}: {
  index: IndexPort;
  commands?: readonly PaletteCommand[];
  /** Commands the query itself calls for — a pasted link, say — listed first. */
  offerFor?: (query: string) => readonly PaletteCommand[];
  /**
   * Changes whenever the index does. A note made a moment ago is indexed after
   * it opens, so a search typed in between would otherwise stay empty.
   */
  changeKey?: string;
  /** Where the query and the chosen row are kept (#261). */
  store: OverlayStore;
  /** Search by meaning in the open vault (P32-02); null or left out, it is not offered. */
  semantic?: MeaningSource | null;
}) {
  const { query, selected, includeArchived, byMeaning: meaningAsked } = usePaletteInput(store);
  const byMeaning = meaningAsked && semantic !== null && semantic !== undefined;
  // Moves as the cache of meanings is built, so a search by meaning is asked again and notes
  // reached since are found without typing again; heard only while searching by meaning.
  const semanticKey = useSemanticKey(byMeaning ? semantic : null);
  const [answer, setAnswer] = useState<Answer>(NO_ANSWER);
  // By meaning, the question is asked as typed: punctuation and all, it still means something.
  const prepared = byMeaning ? nonEmpty(query.trim()) : toSearchQuery(query);
  const asking =
    prepared === null
      ? ''
      : `${String(includeArchived)}:${byMeaning ? 'meaning' : 'words'}:${prepared}`;
  // Only hits that answered the search on screen are shown: while a query typed
  // during a build waits, the last query's hits are not this one's to open.
  const hits = answer.asked === asking ? answer.hits : NO_HITS;
  // Searched again once per settled index, never while it is being written,
  // and not at all for an empty query: the palette shut asks nothing.
  const searchKey =
    prepared === null
      ? null
      : changeKey === BUILDING
        ? BUILDING
        : `${changeKey ?? ''}${byMeaning ? `|${semanticKey}` : ''}`;
  // What the hits on screen answered, and which one is chosen, for a search run
  // again only because the index moved: it keeps the person's place.
  const shown = useRef({ asked: '', hits: NO_HITS, selected: 0, ahead: 0 });

  useEffect(() => {
    if (prepared === null) {
      setAnswer(NO_ANSWER);
      return;
    }
    if (searchKey === BUILDING) return;

    let cancelled = false;
    const asked = asking;
    const searching =
      byMeaning && semantic !== null && semantic !== undefined
        ? afterTyping(MEANING_TYPING_MS, () =>
            meaningHits(semantic, { query: prepared, includeArchived }),
          )
        : {
            // The highlights in literature notes too, after the notes, each opening at its block (#507).
            promise: searchNotes({
              index,
              query: prepared,
              limit: LIMIT,
              includeArchived,
              highlights: true,
            }).then((hits) => ({ hits })),
            cancel: () => undefined,
          };
    searching.promise
      .then((found) => {
        if (cancelled) return;
        const was = shown.current;
        setAnswer({ asked, ...found });
        // The place is kept only for the same search answered again.
        const place = was.asked === asked ? keptPlace(was, found.hits) : 0;
        changePalette(store, (input) => ({ ...input, selected: place }));
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // By words, a half-typed query the index cannot parse yet simply matches nothing;
        // by meaning, the model may be missing, which the palette says.
        const meaning = byMeaning
          ? { progress: null, problem: messageWithoutPaths(cause) }
          : undefined;
        setAnswer({ asked, hits: NO_HITS, ...(meaning !== undefined && { meaning }) });
      });

    return () => {
      cancelled = true;
      searching.cancel();
    };
  }, [index, semantic, byMeaning, prepared, includeArchived, asking, searchKey, store]);

  const offered = useMemo(
    () => [...offerFor(query), ...matchingCommands(query, commands)],
    [query, commands, offerFor],
  );
  const count = offered.length + hits.length;
  useEffect(() => {
    // The search the hits on screen answered, not the query typed since.
    shown.current = {
      asked: hits === NO_HITS ? '' : answer.asked,
      hits,
      selected,
      ahead: offered.length,
    };
  });

  const move = useCallback(
    (delta: number) => changePalette(store, (input) => withMoved(input, delta, count)),
    [store, count],
  );

  const changeQuery = useCallback(
    (next: string) => changePalette(store, (input) => withQuery(input, next)),
    [store],
  );

  const changeArchived = useCallback(
    (next: boolean) => changePalette(store, (input) => withArchived(input, next)),
    [store],
  );

  const changeMeaning = useCallback(
    (next: boolean) => changePalette(store, (input) => withMeaning(input, next)),
    [store],
  );

  return {
    query,
    setQuery: changeQuery,
    commands: offered,
    hits,
    selected,
    move,
    /** Archived notes are left out of a search unless this is on (U-22). */
    includeArchived,
    setIncludeArchived: changeArchived,
    /** Searching by meaning: offered only where the vault has semantic search. */
    byMeaning,
    setByMeaning: changeMeaning,
    /** How the search by meaning on screen stands; null when searching by words. */
    meaning: byMeaning && answer.asked === asking ? (answer.meaning ?? null) : null,
  };
}

/**
 * `ask` after `milliseconds` without a call to cancel it: a key typed into a
 * question by meaning cancels the one before it, so the model is asked about
 * the words typed, not each letter on the way to them.
 */
function afterTyping<T>(milliseconds: number, ask: () => Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => ask().then(resolve, reject), milliseconds);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== null) clearTimeout(timer);
    },
  };
}

const nonEmpty = (text: string): string | null => (text === '' ? null : text);

/**
 * Blocks by meaning, as palette rows: the note's title, what the block says,
 * and its id when it has one, so choosing the row opens the note there. Rows
 * that would open the same place — two blocks of a note with no id — are one
 * row, the closer block's.
 */
async function meaningHits(
  semantic: MeaningSource,
  { query, includeArchived }: { query: string; includeArchived: boolean },
): Promise<{ hits: readonly SearchHit[]; meaning: MeaningStatus }> {
  const answer = await semantic.search({ query, limit: MEANING_ASKED, includeArchived });
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const { path, title, text, block } of answer.hits) {
    if (hits.length === LIMIT) break;
    const place = `${path}#${block ?? ''}`;
    if (seen.has(place)) continue;
    seen.add(place);
    hits.push({ path, title, snippet: text, ...(block !== null && { block }) });
  }
  return { hits, meaning: { progress: answer.progress, problem: null } };
}

/** Which result a hit is: its note, and its block for a highlight in it. */
const sameHit = (left: SearchHit | undefined, right: SearchHit) =>
  left !== undefined && left.path === right.path && left.block === right.block;

/**
 * Where the chosen result is once the same search is answered again: on the
 * same note (or highlight) if it still matches, else as near its place as the
 * list allows. Commands come first and do not move, since the query has not
 * changed.
 */
function keptPlace(
  was: { readonly hits: readonly SearchHit[]; readonly selected: number; readonly ahead: number },
  found: readonly SearchHit[],
): number {
  if (was.selected < was.ahead) return was.selected;
  const chosen = was.hits[was.selected - was.ahead];
  const at = found.findIndex((hit) => sameHit(chosen, hit));
  if (at >= 0) return was.ahead + at;
  return Math.max(0, Math.min(was.selected, was.ahead + found.length - 1));
}
