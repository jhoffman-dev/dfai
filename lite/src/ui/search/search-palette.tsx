import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { folderOf, rankNoteSuggestions } from '../../application/index.ts';
import type { VaultPath } from '../../domain/vault/index.ts';
import { useApp } from '../services.ts';
import './search.css';

const NAME_ROWS = 6;
const TEXT_ROWS = 20;

type PaletteRow =
  | { readonly kind: 'name'; readonly path: VaultPath; readonly title: string }
  | {
      readonly kind: 'text';
      readonly path: VaultPath;
      readonly title: string;
      readonly snippet: string;
    }
  | { readonly kind: 'create'; readonly name: string };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The snippet with each word of the query marked, as React text (never HTML). */
function highlighted(snippet: string, query: string): ReactNode[] {
  const words = query
    .split(/\s+/)
    .filter((word) => word !== '')
    .map(escapeRegExp);
  if (words.length === 0) return [snippet];
  const parts = snippet.split(new RegExp(`(${words.join('|')})`, 'gi'));
  return parts.map((part, at) => (at % 2 === 1 ? <mark key={at}>{part}</mark> : part));
}

function usePaletteRows(query: string): PaletteRow[] {
  const { services } = useApp();
  return useMemo(() => {
    const typed = query.trim();
    if (typed === '') return [];
    const index = services.session.index;
    const names = rankNoteSuggestions({
      query: typed,
      notes: index.paths(),
      resolve: (target) => index.resolve(target),
      limit: NAME_ROWS,
    });
    const named = new Set(names.map((note) => note.path));
    const texts = services.search
      .search(typed, { limit: TEXT_ROWS })
      .filter((hit) => !named.has(hit.path));
    const exact = names.some((note) => note.match === 'exact');
    return [
      ...names.map((note) => ({ kind: 'name' as const, path: note.path, title: note.title })),
      ...texts.map((hit) => ({ kind: 'text' as const, ...hit })),
      ...(exact ? [] : [{ kind: 'create' as const, name: typed }]),
    ];
  }, [query, services]);
}

/** ⌘K: one field that switches to a note by name, searches the text, or makes the note. */
export function SearchPalette({ onClose }: { onClose: () => void }) {
  const { actions } = useApp();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const rows = usePaletteRows(query);
  const current = Math.min(selected, rows.length - 1);

  const choose = (row: PaletteRow | undefined) => {
    if (row === undefined) return;
    onClose();
    if (row.kind === 'create') actions.followLink(row.name).catch(actions.report);
    else actions.openNote(row.path);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') onClose();
    else if (event.key === 'Enter') choose(rows[current]);
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setSelected((current + step + rows.length) % Math.max(rows.length, 1));
    } else return;
    event.preventDefault();
  };

  return (
    <div
      className="dialog-scrim"
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search notes">
        <input
          className="palette-input"
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls="palette-results"
          aria-activedescendant={rows.length > 0 ? `palette-row-${current}` : undefined}
          placeholder="Find or create a note…"
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul id="palette-results" className="palette-results" role="listbox" aria-label="Results">
          {rows.map((row, at) => (
            <li
              key={row.kind === 'create' ? 'create' : `${row.kind}:${row.path}`}
              id={`palette-row-${at}`}
              role="option"
              aria-selected={at === current}
              className={`palette-row is-${row.kind}`}
              onPointerMove={() => setSelected(at)}
              onClick={() => choose(row)}
            >
              {row.kind === 'create' ? (
                <span className="palette-title">Create note “{row.name}”</span>
              ) : (
                <>
                  <span className="palette-title">{row.title}</span>
                  <span className="palette-folder">{folderOf(row.path)}</span>
                  {row.kind === 'text' ? (
                    <span className="palette-snippet">{highlighted(row.snippet, query)}</span>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
