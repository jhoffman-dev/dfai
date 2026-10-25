import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { stepMatch } from '@dfai/domain';

/*
 * Find in the document (#504) or the book (#505): ⌘F opens it, typing
 * searches every page or chapter, Enter and ⇧Enter step through what was
 * found, Escape closes it. A match is the reader's own (a PDF's page and
 * boxes, a book's chapter and offsets); `show` brings one into view.
 */

interface Found<M> {
  readonly phrase: string;
  readonly matches: readonly M[];
  readonly more: boolean;
}

const NO_MATCHES: readonly never[] = [];

export function useFind<M>({
  onSearch,
  show,
}: {
  onSearch: (phrase: string) => Promise<{ matches: readonly M[]; more: boolean }>;
  show: (match: M) => void;
}) {
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState('');
  // Each result knows the phrase it is for, so a result for what was typed before is never shown.
  const [result, setResult] = useState<Found<M> | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const searched = useRef(0);
  const searching = open && phrase.trim() !== '';
  useEffect(() => {
    const ask = (searched.current += 1);
    if (!searching) return;
    onSearch(phrase).then(
      (answer) => {
        if (ask !== searched.current) return;
        setResult({ phrase, ...answer });
        setCurrent(answer.matches.length === 0 ? null : 0);
      },
      // A search that failed finds nothing; the next keystroke asks again.
      () => ask === searched.current && setResult({ phrase, matches: [], more: false }),
    );
  }, [searching, phrase, onSearch]);
  const found = searching && result?.phrase === phrase ? result : null;
  const matches: readonly M[] = found?.matches ?? NO_MATCHES;
  const currentMatch = current === null ? null : (matches[current] ?? null);
  useEffect(() => {
    if (currentMatch !== null) show(currentMatch);
  }, [currentMatch, show]);
  // Stable, so a button bar that holds them is not drawn again for every keystroke in the field.
  const toggle = useCallback(() => setOpen((was) => !was), []);
  const close = useCallback(() => setOpen(false), []);
  const step = (back: boolean) => setCurrent((was) => stepMatch(was, matches.length, back));
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      setOpen(true);
    }
  };
  return {
    open,
    phrase,
    setPhrase,
    found,
    matches,
    current,
    currentMatch,
    step,
    onKeyDown,
    toggle,
    close,
  };
}

/** What the find bar shows and steps, whatever a match is. */
type FindState = Pick<
  ReturnType<typeof useFind<unknown>>,
  'phrase' | 'setPhrase' | 'step' | 'close' | 'found' | 'current'
>;

export function FindBar({ find }: { find: FindState }) {
  return (
    <div className="pdf-find-bar" role="search">
      <input
        type="search"
        className="pdf-find-bar__field"
        aria-label="Find in document"
        placeholder="Find in document"
        autoFocus
        value={find.phrase}
        onChange={(event) => find.setPhrase(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            find.step(event.shiftKey);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            find.close();
          }
        }}
      />
      <span className="pdf-find-bar__count" aria-live="polite">
        {countLabel(find)}
      </span>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        aria-label="Previous match"
        onClick={() => find.step(true)}
      >
        ↑
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        aria-label="Next match"
        onClick={() => find.step(false)}
      >
        ↓
      </button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={find.close}>
        Done
      </button>
    </div>
  );
}

function countLabel(find: FindState): string {
  if (find.phrase.trim() === '') return '';
  if (find.found === null) return 'Searching…';
  const total = find.found.matches.length;
  if (total === 0) return 'Not found';
  return `${(find.current ?? 0) + 1} of ${total}${find.found.more ? '+' : ''}`;
}
