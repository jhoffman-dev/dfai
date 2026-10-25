import { memo, useEffect, useRef } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { createVaultPath, placeCrumb, type PaletteCommand } from '@dfai/domain';
import type { SearchHit } from '@dfai/application';
import { Icon, sidebarGlyph } from './icon.tsx';
import { isImeKey } from './ime.ts';
import { Key, KeyHints } from './key-hints.tsx';
import { useReturnFocus, type FocusFallback } from './return-focus.ts';
import { useSteadyCallback } from './steady-callback.ts';
import { Toggle } from './toggle.tsx';
import type { ArchivedToggle } from './view-toolbar.tsx';

const HINTS = [
  ['↑ ↓', 'to move'],
  ['↵', 'to open'],
  ['esc', 'to close'],
] as const;

/** Splits a snippet on the markers the index puts around matching words. */
function highlight(snippet: string) {
  return snippet.split(/(<<[^>]*>>)/).map((part, index) =>
    part.startsWith('<<') && part.endsWith('>>') ? (
      <mark key={index} className="palette__mark">
        {part.slice(2, -2)}
      </mark>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}

/**
 * "By meaning": blocks found by what they mean rather than by their words
 * (P32-02), and how that search stands.
 */
export interface MeaningToggle {
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
  /** How far the cache of meanings is built, as the hits on screen were found; null before any. */
  readonly progress: {
    readonly done: number;
    readonly total: number;
    /** Why the build stopped, when it did. */
    readonly failure?: string | null;
  } | null;
  /** Why the search by meaning could not run, or null. */
  readonly problem: string | null;
}

/**
 * Full-text search over the vault, driven from the keyboard.
 *
 * Mounted only while it is open, so the dialog is held open and closing is the
 * parent's business. Focus trapping, focus restoration, Escape, the scroll lock
 * and the portal are Base UI's — see ADR-0015.
 *
 * The viewport carries `palette__backdrop` rather than `Dialog.Backdrop`: that
 * class is both the scrim and the flexbox that centres the palette, and the
 * viewport is the part that wraps the popup.
 */
export function SearchPalette({
  query,
  hits,
  selected,
  onQuery,
  onMove,
  onPick,
  onClose,
  fallbackFocus,
  commands = [],
  onCommand = () => undefined,
  archived,
  meaning,
}: {
  query: string;
  hits: readonly SearchHit[];
  selected: number;
  onQuery: (query: string) => void;
  onMove: (delta: number) => void;
  /** A hit chosen: its note, and the highlight's block when the hit is a highlight in it (#507). */
  onPick: (path: string, block?: string) => void;
  onClose: () => void;
  /** Where focus goes on close if what opened the palette has gone. */
  fallbackFocus?: FocusFallback;
  /** What the query names that the palette can do, listed above the notes. */
  commands?: readonly PaletteCommand[];
  onCommand?: (id: string) => void;
  /** "Include archived": whether the search reaches the Archive too; left out, it is not offered. */
  archived?: ArchivedToggle;
  /** "By meaning": left out, it is not offered. */
  meaning?: MeaningToggle;
}) {
  const byMeaning = meaning?.on === true;
  const finalFocus = useReturnFocus(fallbackFocus);
  // Steady, so a command or hit still listed after a key is typed is not drawn again for it.
  const runCommand = useSteadyCallback(onCommand);
  const pick = useSteadyCallback(onPick);
  const changeArchived = useSteadyCallback((included: boolean) => archived?.onChange(included));
  const changeMeaning = useSteadyCallback((on: boolean) => meaning?.onChange(on));
  const hitsRef = useRef<HTMLUListElement>(null);
  // The selection the list was last scrolled for. It starts at the one the
  // palette opens on, which is already drawn in view: opening does no scroll work.
  const scrolledFor = useRef(selected);
  useEffect(() => {
    if (scrolledFor.current === selected) return;
    scrolledFor.current = selected;
    // No list is drawn while nothing matches, and then there is nothing to keep in
    // view; jsdom has no scrollIntoView, and with nothing laid out nothing needs it.
    hitsRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Viewport className="palette__backdrop">
          <Dialog.Popup className="palette" finalFocus={finalFocus} aria-label="Search notes">
            <div className="palette__field">
              <Icon name="search" size={19} className="palette__field-icon" />
              <input
                className="palette__input"
                type="search"
                placeholder="Search the vault…"
                aria-label="Search the vault"
                value={query}
                onChange={(event) => onQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    onMove(1);
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    onMove(-1);
                  } else if (event.key === 'Enter' && !isImeKey(event)) {
                    event.preventDefault();
                    const command = commands[selected];
                    const hit = hits[selected - commands.length];
                    if (command !== undefined) onCommand(command.id);
                    else if (hit !== undefined) pickHit(hit, onPick);
                  }
                }}
              />
              <span aria-hidden="true">
                <Key>esc</Key>
              </span>
            </div>
            {(archived !== undefined || meaning !== undefined) && (
              <PaletteScope
                archivable={archived !== undefined}
                archived={archived?.included === true}
                onArchived={changeArchived}
                meaningful={meaning !== undefined}
                byMeaning={byMeaning}
                onMeaning={changeMeaning}
              />
            )}
            {byMeaning && (
              <MeaningNote
                problem={meaning?.problem ?? null}
                done={meaning?.progress?.done ?? null}
                total={meaning?.progress?.total ?? 0}
                failure={meaning?.progress?.failure ?? null}
              />
            )}

            {query.trim() !== '' && hits.length === 0 && commands.length === 0 ? (
              <p className="palette__empty">Nothing matches.</p>
            ) : (
              <ul ref={hitsRef} className="palette__hits" role="listbox" aria-label="Results">
                {commands.map((command, index) => (
                  <li key={command.id}>
                    <CommandRow
                      command={command}
                      selected={index === selected}
                      onRun={runCommand}
                    />
                  </li>
                ))}
                {hits.map((hit, index) => (
                  <li key={hitKey(hit)}>
                    <Hit
                      hit={hit}
                      selected={index + commands.length === selected}
                      onPick={pick}
                      byMeaning={byMeaning}
                    />
                  </li>
                ))}
              </ul>
            )}
            <KeyHints hints={HINTS} />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Something to do rather than a note to open: a plus in the kind's tile, and
 * its name. Drawn again only when it is chosen or let go, or its command
 * changes: typing on draws the commands still listed as they were.
 */
const CommandRow = memo(function CommandRow({
  command,
  selected,
  onRun,
}: {
  command: PaletteCommand;
  selected: boolean;
  onRun: (id: string) => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={selected ? 'palette__hit palette__hit--on' : 'palette__hit'}
      onMouseDown={(event) => {
        event.preventDefault();
        onRun(command.id);
      }}
    >
      <span className="palette__kind" aria-hidden="true">
        <Icon name="plus" size={16} />
      </span>
      <span className="palette__text">
        <span className="palette__title">{command.label}</span>
      </span>
      {selected && (
        <span className="palette__enter" aria-hidden="true">
          <Key>↵</Key>
        </span>
      )}
    </button>
  );
});

/** What tells one hit from another: its note, and its block for a highlight in it. */
const hitKey = (hit: SearchHit) =>
  hit.block === undefined ? hit.path : `${hit.path}#^${hit.block}`;

/** Opens a hit: its note, at its block when it is a highlight. */
function pickHit(hit: SearchHit, onPick: (path: string, block?: string) => void) {
  if (hit.block === undefined) onPick(hit.path);
  else onPick(hit.path, hit.block);
}

/**
 * The two switches under the field. Drawn again only when one is switched or
 * offered or let go: typing on leaves them as they were, so what it is given
 * is plain values and callbacks that stay the same.
 */
const PaletteScope = memo(function PaletteScope({
  archivable,
  archived,
  onArchived,
  meaningful,
  byMeaning,
  onMeaning,
}: {
  archivable: boolean;
  archived: boolean;
  onArchived: (included: boolean) => void;
  meaningful: boolean;
  byMeaning: boolean;
  onMeaning: (on: boolean) => void;
}) {
  return (
    <div className="palette__scope">
      {archivable && (
        <label className="palette__switch">
          <Toggle label="Include archived" checked={archived} onChange={onArchived} />
          <span aria-hidden="true">Include archived</span>
        </label>
      )}
      {meaningful && (
        <label className="palette__switch">
          <Toggle label="By meaning" checked={byMeaning} onChange={onMeaning} />
          <span aria-hidden="true">By meaning</span>
        </label>
      )}
    </div>
  );
});

/**
 * What the palette says of a search by meaning: why it could not run, why the
 * cache of meanings stopped being built, or that it is still being built, so a
 * missing note is expected.
 */
const MeaningNote = memo(function MeaningNote({
  problem,
  done,
  total,
  failure,
}: {
  problem: string | null;
  /** Notes read for meaning so far; null before any search has answered. */
  done: number | null;
  total: number;
  failure: string | null;
}) {
  if (problem !== null)
    return <p className="palette__note">Search by meaning is not available: {problem}</p>;
  if (done === null) return null;
  if (failure !== null)
    return (
      <p className="palette__note">
        Stopped reading notes for meaning ({done} of {total}): {failure}
      </p>
    );
  if (done >= total) return null;
  return (
    <p className="palette__note" role="status">
      Still reading notes for meaning: {done} of {total}.
    </p>
  );
});

/**
 * One result: what kind of note it is and where it lives (never `.atlas/…`),
 * its title, and the words around the match. A highlight says so, and which
 * source it is in, in place of the folder; a block found by meaning shows
 * what the block says.
 */
const Hit = memo(function Hit({
  hit,
  selected,
  onPick,
  byMeaning,
}: {
  hit: SearchHit;
  selected: boolean;
  onPick: (path: string, block?: string) => void;
  byMeaning: boolean;
}) {
  const place = placeCrumb(createVaultPath(hit.path));
  const isHighlight = hit.block !== undefined && !byMeaning;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={selected ? 'palette__hit palette__hit--on' : 'palette__hit'}
      onMouseDown={(event) => {
        event.preventDefault();
        pickHit(hit, onPick);
      }}
    >
      <span className="palette__kind" aria-hidden="true">
        <Icon name={isHighlight ? 'quote' : sidebarGlyph(place.icon)} size={16} />
      </span>
      <span className="palette__text">
        <span className="palette__title">{hit.title}</span>
        <span className="palette__detail">
          <span className="palette__place">{isHighlight ? 'Highlight' : place.parent}</span>
          {hit.snippet !== '' && <span className="palette__snippet">{highlight(hit.snippet)}</span>}
        </span>
      </span>
      {selected && (
        <span className="palette__enter" aria-hidden="true">
          <Key>↵</Key>
        </span>
      )}
    </button>
  );
});
