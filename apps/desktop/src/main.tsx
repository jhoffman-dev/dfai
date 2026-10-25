import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import {
  resolveActivityPorts,
  resolveAppInfoPort,
  resolveExportPorts,
  resolveExternalLinks,
  resolveGlobalCapture,
  resolveGoogleCalendar,
  resolveGranola,
  resolveIndexPorts,
  resolveKindle,
  resolveLocalApiPorts,
  resolveChatPorts,
  resolveNotePorts,
  resolvePageSnapshot,
  resolveSemanticPorts,
  resolveSourcePorts,
  resolveSyncPorts,
  resolveVaultPorts,
} from './composition.ts';
import { guardStrayFileDrops } from './file-drop-guard.ts';
import { preloadPages } from './pages-on-first-use.ts';
import { PreloadAfterStart } from './preload-after-start.tsx';
import './styles/index.css';

guardStrayFileDrops(window);

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

createRoot(root).render(
  <StrictMode>
    <App
      appInfo={resolveAppInfoPort()}
      vault={resolveVaultPorts()}
      notes={resolveNotePorts()}
      index={resolveIndexPorts()}
      semantic={resolveSemanticPorts()}
      sources={resolveSourcePorts()}
      links={resolveExternalLinks()}
      snapshot={resolvePageSnapshot()}
      api={resolveLocalApiPorts()}
      chat={resolveChatPorts()}
      activity={resolveActivityPorts()}
      sync={resolveSyncPorts()}
      googleCalendar={resolveGoogleCalendar()}
      granola={resolveGranola()}
      kindle={resolveKindle()}
      globalCapture={resolveGlobalCapture()}
      exporting={resolveExportPorts()}
    />
    {/* What start-up does not draw loads once it has committed, so pages open with no fallback. */}
    <PreloadAfterStart preload={preloadPages} />
  </StrictMode>,
);
