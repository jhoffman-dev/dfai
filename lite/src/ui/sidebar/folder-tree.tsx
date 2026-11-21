import { useVirtualizer } from '@tanstack/react-virtual';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { flattenFolderTree, folderOf } from '../../application/index.ts';
import type { TreeRow, VaultPath } from '../../domain/vault/index.ts';
import { useApp } from '../services.ts';
import { Icon } from '../shell/icons.tsx';
import { useVault } from '../state/vault-store.ts';
import type { MenuTarget } from './menu-items.ts';

const ROW_HEIGHT = 28;
const INDENT = 14;
const CHEVRON = 20;

interface TreeRowProps {
  readonly row: TreeRow;
  readonly index: number;
  readonly active: boolean;
  readonly focusable: boolean;
  readonly onToggle: (path: VaultPath) => void;
  readonly onMenu: (row: TreeRow, event: MouseEvent) => void;
  readonly onFocusRow: (index: number) => void;
}

const TreeRowView = memo(function TreeRowView({
  row,
  index,
  active,
  focusable,
  onToggle,
  onMenu,
  onFocusRow,
}: TreeRowProps) {
  const isFolder = row.kind === 'folder';
  const common = {
    role: 'treeitem',
    'data-index': index,
    tabIndex: focusable ? 0 : -1,
    'aria-level': row.depth + 1,
    // A note lines up with its folder's name, past the chevron.
    style: { paddingLeft: 8 + row.depth * INDENT + (isFolder ? 0 : CHEVRON) },
    onFocus: () => onFocusRow(index),
    onContextMenu: (event: MouseEvent) => onMenu(row, event),
  } as const;

  if (isFolder) {
    return (
      <div
        {...common}
        className="tree-row is-folder"
        aria-expanded={row.expanded}
        onClick={() => onToggle(row.path)}
      >
        <span className={`tree-chevron${row.expanded ? ' is-open' : ''}`}>
          <Icon name="chevron" />
        </span>
        <span className="sidebar-row-label">{row.name}</span>
        <span className="tree-count">{row.noteCount}</span>
      </div>
    );
  }
  return (
    <a
      {...common}
      className={`tree-row is-note${active ? ' is-active' : ''}`}
      href={`#/note/${encodeURIComponent(row.path)}`}
      aria-current={active ? 'page' : undefined}
      aria-selected={active}
    >
      <span className="sidebar-row-label">{row.name}</span>
    </a>
  );
});

function ancestorsOf(path: VaultPath): VaultPath[] {
  const folders: VaultPath[] = [];
  for (let folder = folderOf(path); folder !== ''; folder = folderOf(folder)) folders.push(folder);
  return folders;
}

/** Remembers which folders are open, per device, and opens the folders above the note shown. */
function useExpandedFolders(activePath: VaultPath | null) {
  const { services, actions } = useApp();
  const [state, setState] = useState(() => ({
    expanded: new Set(services.settings.load().ui.expandedFolders) as ReadonlySet<VaultPath>,
    revealedFor: null as VaultPath | null,
  }));

  // Reveal once per note opened (adjusted while rendering), so a folder closed by hand stays closed.
  let current = state;
  if (activePath !== null && activePath !== state.revealedFor) {
    const closed = ancestorsOf(activePath).filter((folder) => !state.expanded.has(folder));
    const expanded = closed.length === 0 ? state.expanded : new Set([...state.expanded, ...closed]);
    current = { expanded, revealedFor: activePath };
    setState(current);
  }

  const { expanded } = current;
  useEffect(() => {
    actions.updatePrefs({ expandedFolders: [...expanded].sort() });
  }, [expanded, actions]);

  const toggle = useCallback((path: VaultPath) => {
    setState((before) => {
      const next = new Set(before.expanded);
      if (!next.delete(path)) next.add(path);
      return { ...before, expanded: next };
    });
  }, []);
  return { expanded, toggle };
}

/** The vault's folders and notes, virtualised so a 2,000-note vault scrolls as one of ten. */
export function FolderTree({
  activePath,
  onMenu,
}: {
  activePath: VaultPath | null;
  onMenu: (target: MenuTarget) => void;
}) {
  const tree = useVault((vault) => vault.tree);
  const { expanded, toggle } = useExpandedFolders(activePath);
  const rows = useMemo(() => flattenFolderTree(tree, expanded), [tree, expanded]);
  const scroller = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const current = Math.min(focusIndex, Math.max(0, rows.length - 1));
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const openMenu = useCallback(
    (row: TreeRow, event: MouseEvent) => {
      event.preventDefault();
      const { clientX: x, clientY: y } = event;
      onMenu(
        row.kind === 'folder'
          ? { kind: 'folder', path: row.path, x, y }
          : { kind: 'note', path: row.path, x, y, favoriteAt: null },
      );
    },
    [onMenu],
  );

  const focusRow = (index: number) => {
    const at = Math.max(0, Math.min(rows.length - 1, index));
    setFocusIndex(at);
    virtualizer.scrollToIndex(at);
    requestAnimationFrame(() =>
      scroller.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.focus(),
    );
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const row = rows[current];
    if (row === undefined) return;
    const key = event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      focusRow(current + (key === 'ArrowDown' ? 1 : -1));
    } else if (key === 'Home' || key === 'End') {
      focusRow(key === 'Home' ? 0 : rows.length - 1);
    } else if (row.kind === 'folder' && (key === 'Enter' || key === ' ')) {
      toggle(row.path);
    } else if (row.kind === 'folder' && key === (row.expanded ? 'ArrowLeft' : 'ArrowRight')) {
      toggle(row.path);
    } else if (key === 'ArrowLeft' && row.depth > 0) {
      const parent = folderOf(row.path);
      focusRow(rows.findIndex((other) => other.kind === 'folder' && other.path === parent));
    } else if (key === 'ContextMenu' || (event.shiftKey && key === 'F10')) {
      const box = (event.target as HTMLElement).getBoundingClientRect();
      const at = { x: box.left + 24, y: box.bottom };
      onMenu(
        row.kind === 'folder'
          ? { kind: 'folder', path: row.path, ...at }
          : { kind: 'note', path: row.path, ...at, favoriteAt: null },
      );
    } else {
      return;
    }
    event.preventDefault();
  };

  return (
    <section className="sidebar-section sidebar-tree" aria-labelledby="notes-heading">
      <h2 id="notes-heading" className="sidebar-heading">
        Notes
      </h2>
      <div
        ref={scroller}
        className="tree-scroller"
        role="tree"
        aria-label="Notes"
        onKeyDown={onKeyDown}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index] as TreeRow;
            return (
              <div
                key={`${row.kind}:${row.path}`}
                className="tree-slot"
                style={{ transform: `translateY(${item.start}px)`, height: ROW_HEIGHT }}
              >
                <TreeRowView
                  row={row}
                  index={item.index}
                  active={row.path === activePath}
                  focusable={item.index === current}
                  onToggle={toggle}
                  onMenu={openMenu}
                  onFocusRow={setFocusIndex}
                />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
