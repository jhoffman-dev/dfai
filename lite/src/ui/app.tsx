import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { GraphPage } from './graph-page/graph-page.tsx';
import { NotePane, preloadEditor } from './note/note-pane.tsx';
import type { Route } from './routing/route.ts';
import { useRoute } from './routing/use-route.ts';
import { SearchPalette } from './search/search-palette.tsx';
import { AppContext, useApp, type AppContextValue, type AppServices } from './services.ts';
import { Icon } from './shell/icons.tsx';
import { useShortcuts } from './shell/use-shortcuts.ts';
import { useStartRoute } from './shell/use-start-route.ts';
import { Sidebar } from './sidebar/sidebar.tsx';
import { createNoteActions } from './state/note-actions.ts';
import { createUiStore, useUi } from './state/ui-store.ts';
import { createVaultStore, useVault } from './state/vault-store.ts';
import type { SyncControls } from './sync/sync-status.ts';
import { TagsPage } from './tags/tags-page.tsx';
import './theme.css';
import './app.css';
import './shell/dialog.css';

const SettingsDialog = lazy(() => import('./settings/settings-dialog.tsx'));

function contextFor(services: AppServices): AppContextValue {
  const deps = { store: services.noteStore, session: services.session };
  const ui = createUiStore({ preview: services.settings.load().ui.preview });
  const vault = createVaultStore(services.session);
  const actions = createNoteActions({ deps, ui, settings: services.settings });
  return { services, deps, vault, ui, actions };
}

/** Fetching the vault on the first sync, or a vault with no notes yet. */
function EmptyVault({ sync }: { sync: SyncControls }) {
  const status = useSyncExternalStore(sync.subscribe, sync.getStatus);
  return (
    <div className="app-empty" role="status">
      {status.kind === 'syncing'
        ? 'Fetching your notes from GitHub…'
        : 'No notes yet. Start one with New note.'}
    </div>
  );
}

function Home() {
  const { actions, services } = useApp();
  const empty = useVault((vault) => vault.tree.noteCount === 0);
  if (empty && services.sync !== null) return <EmptyVault sync={services.sync} />;
  return (
    <div className="app-empty">
      <p>
        Press <kbd>⌥N</kbd> or <kbd>Ctrl N</kbd> to start a note, <kbd>⌘K</kbd> to find one.
      </p>
      <button
        type="button"
        className="primary-button"
        onClick={() => actions.newNote().catch(actions.report)}
      >
        New note
      </button>
    </div>
  );
}

function MainPane({ route }: { route: Route }) {
  const { services } = useApp();
  switch (route.kind) {
    case 'note':
      return <NotePane key={route.path} path={route.path} />;
    case 'tags':
      return <TagsPage tag={route.tag} />;
    case 'graph':
      return <GraphPage activePath={services.settings.load().ui.lastOpenPath} />;
    case 'home':
    case 'new':
      return <Home />;
  }
}

function Notice() {
  const { ui } = useApp();
  const notice = useUi((state) => state.notice);
  if (notice === null) return null;
  return (
    <div className="app-notice" role="status">
      <span>{notice}</span>
      <button type="button" className="quiet-button" onClick={() => ui.setState({ notice: null })}>
        Dismiss
      </button>
    </div>
  );
}

function Shell() {
  const { services, ui, actions } = useApp();
  const route = useRoute();
  const paletteOpen = useUi((state) => state.paletteOpen);
  const settingsOpen = useUi((state) => state.settingsOpen);
  const drawerOpen = useUi((state) => state.drawerOpen);
  useShortcuts(route);
  // The editor's code loads straight after the first paint, so ⌘N never waits for it.
  useEffect(() => {
    preloadEditor().catch(actions.report);
  }, [actions]);
  useStartRoute(route);
  // A note or a page chosen in the drawer closes it, on a phone.
  useEffect(() => ui.setState({ drawerOpen: false }), [route, ui]);

  return (
    <div className="app" data-drawer={drawerOpen ? 'open' : 'closed'}>
      <nav className="app-sidebar" aria-label="Sidebar">
        <Sidebar route={route} />
      </nav>
      <div className="app-scrim" onClick={() => ui.setState({ drawerOpen: false })} />
      <main className="app-main">
        <div className="app-topbar">
          <button
            type="button"
            className="quiet-button"
            aria-label="Open the sidebar"
            onClick={() => ui.setState({ drawerOpen: true })}
          >
            <Icon name="menu" />
          </button>
          <span className="grow" />
          <button
            type="button"
            className="quiet-button"
            aria-label="Search"
            onClick={() => ui.setState({ paletteOpen: true })}
          >
            <Icon name="search" />
          </button>
        </div>
        {services.sync !== null ? null : (
          <div className="app-banner" role="note">
            <span>Sample vault — connect a GitHub repository in Settings.</span>
            <button
              type="button"
              className="quiet-button"
              onClick={() => ui.setState({ settingsOpen: true })}
            >
              Settings
            </button>
          </div>
        )}
        <MainPane route={route} />
      </main>
      {paletteOpen ? <SearchPalette onClose={() => ui.setState({ paletteOpen: false })} /> : null}
      {settingsOpen ? (
        <Suspense fallback={null}>
          <SettingsDialog onClose={() => ui.setState({ settingsOpen: false })} />
        </Suspense>
      ) : null}
      <Notice />
    </div>
  );
}

/** The app: the sidebar, the main pane the route chooses, and the palette and dialogs over them. */
export function App({ services }: { services: AppServices }) {
  const [context] = useState(() => contextFor(services));
  useEffect(() => context.vault.connect(), [context]);
  return (
    <AppContext.Provider value={context}>
      <Shell />
    </AppContext.Provider>
  );
}
