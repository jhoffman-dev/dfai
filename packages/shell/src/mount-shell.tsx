import { StrictMode, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import { guardStrayFileDrops } from './file-drop-guard.ts';
import { preloadPages } from './pages-on-first-use.ts';
import { PreloadAfterStart } from './preload-after-start.tsx';
import './styles/index.css';

/** Every port the shell runs on, as a platform's composition root builds them. */
export type AppPorts = ComponentProps<typeof App>;

/**
 * What a platform's composition root hands the shell (#656): its adapters
 * behind the shell's ports. What the platform can do at all joins it here, so
 * the shell hides what a platform lacks without asking which platform it is on (#657).
 */
export type ShellComposition = { readonly ports: AppPorts };

/** The pages holding a shell now: one each, or two Apps share a root and two guards a window. */
const holding = new WeakSet<Window>();

/** Draws the app into the page's `#root`, as every platform starts it; the answer takes it down again. */
export function mountShell({ ports }: ShellComposition, page: Window = window): () => void {
  const element = page.document.getElementById('root');
  if (!element) throw new Error('index.html is missing #root');
  if (holding.has(page)) throw new Error('this page already holds the app: take it down first');
  holding.add(page);
  const stopGuarding = guardStrayFileDrops(page);
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <App {...ports} />
      {/* What start-up does not draw loads once it has committed, so pages open with no fallback. */}
      <PreloadAfterStart preload={preloadPages} />
    </StrictMode>,
  );
  return () => {
    root.unmount();
    stopGuarding();
    holding.delete(page);
  };
}
