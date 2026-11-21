import { useCallback, useState } from 'react';
import { noteTitle } from '../../application/index.ts';
import type { VaultPath } from '../../domain/vault/index.ts';
import type { Route } from '../routing/route.ts';
import { useApp } from '../services.ts';
import { Icon } from '../shell/icons.tsx';
import { useVault } from '../state/vault-store.ts';
import { SyncChip } from '../sync/sync-chip.tsx';
import { FavoritesSection } from './favorites-section.tsx';
import { FolderTree } from './folder-tree.tsx';
import { menuItemsFor, type MenuTarget } from './menu-items.ts';
import { MoveDialog } from './move-dialog.tsx';
import { RowMenu } from './row-menu.tsx';
import './sidebar.css';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The sidebar: new note and search on top, favourites, the folder tree, and sync in the footer. */
export function Sidebar({ route }: { route: Route }) {
  const { actions, ui, services } = useApp();
  const favorites = useVault((vault) => vault.favorites);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [moving, setMoving] = useState<VaultPath | null>(null);
  const activePath = route.kind === 'note' ? route.path : null;
  const closeMenu = useCallback(() => setMenu(null), []);

  return (
    <>
      <div className="sidebar-top">
        <button
          type="button"
          className="sidebar-new"
          onClick={() => actions.newNote().catch(actions.report)}
        >
          <Icon name="plus" />
          <span>New note</span>
          <kbd>{IS_MAC ? '⌥N' : 'Alt N'}</kbd>
        </button>
        <button
          type="button"
          className="sidebar-link"
          onClick={() => ui.setState({ paletteOpen: true })}
        >
          <Icon name="search" />
          <span>Search</span>
          <kbd>{IS_MAC ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <a
          className="sidebar-link"
          href="#/tags"
          aria-current={route.kind === 'tags' ? 'page' : undefined}
        >
          <Icon name="tag" />
          <span>Tags</span>
        </a>
        <a
          className="sidebar-link"
          href="#/graph"
          aria-current={route.kind === 'graph' ? 'page' : undefined}
        >
          <Icon name="graph" />
          <span>Graph</span>
        </a>
      </div>
      <div className="sidebar-scroll">
        <FavoritesSection activePath={activePath} onMenu={setMenu} />
        <FolderTree activePath={activePath} onMenu={setMenu} />
      </div>
      <footer className="sidebar-footer">
        {services.sync === null ? null : <SyncChip sync={services.sync} />}
        <button
          type="button"
          className="quiet-button sidebar-settings"
          onClick={() => ui.setState({ settingsOpen: true })}
        >
          <Icon name="gear" />
          <span>Settings</span>
        </button>
      </footer>
      {menu === null ? null : (
        <RowMenu
          label={menu.kind === 'folder' ? 'Folder actions' : 'Note actions'}
          at={menu}
          onClose={closeMenu}
          items={menuItemsFor(menu, {
            actions,
            favorites,
            activePath,
            title: noteTitle,
            askMove: setMoving,
            confirm: (message) => window.confirm(message),
          })}
        />
      )}
      {moving === null ? null : <MoveDialog path={moving} onClose={() => setMoving(null)} />}
    </>
  );
}
