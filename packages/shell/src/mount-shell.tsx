import { StrictMode, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { entryPointsOffered, type EntryPointsOffered } from '@dfai/application';
import type { PlatformCapabilities } from '@dfai/domain';
import { App } from './app.tsx';
import { guardStrayFileDrops } from './file-drop-guard.ts';
import { preloadPages } from './pages-on-first-use.ts';
import { PreloadAfterStart } from './preload-after-start.tsx';
import './styles/index.css';

/** Every port the shell runs on, as a platform's composition root builds them. */
export type AppPorts = Omit<ComponentProps<typeof App>, 'offered'>;

/**
 * What a platform's composition root hands the shell (#656): its adapters
 * behind the shell's ports, and what the platform can do at all. The shell
 * hides what a platform lacks from that, without asking which platform it is on (#657).
 */
export type ShellComposition = {
  readonly ports: AppPorts;
  readonly capabilities: PlatformCapabilities;
};

/**
 * The ports the app is handed and what it offers, decided once as it mounts
 * (#657). A capability whose adapter the composition left out is off, so the
 * app never has a feature on and its port missing; and a port for a
 * capability that is off is not handed on, so nothing reaches it. The answer
 * is made once: the app keeps one `offered` for its life.
 */
export function composedForApp({ ports, capabilities }: ShellComposition): {
  readonly ports: AppPorts;
  readonly offered: EntryPointsOffered;
} {
  const has = {
    ...capabilities,
    kindle: capabilities.kindle && ports.kindle !== undefined,
    localModels: capabilities.localModels && ports.semantic !== undefined,
    markdownExport: capabilities.markdownExport && ports.exporting !== undefined,
  };
  const { kindle, semantic, exporting, meetings, blocks, ...always } = ports;
  return {
    ports: {
      ...always,
      ...(has.kindle && kindle !== undefined && { kindle }),
      ...(has.localModels && semantic !== undefined && { semantic }),
      ...(has.markdownExport && exporting !== undefined && { exporting }),
      ...(has.googleCalendar && meetings !== undefined && { meetings }),
      ...(has.googleCalendar && blocks !== undefined && { blocks }),
    },
    offered: withCalendarPorts(entryPointsOffered(has), { meetings, blocks }),
  };
}

/**
 * The calendar's two syncs each run on a port of their own, under the one
 * Google Calendar capability: one left out is off, and Settings → Google
 * Calendar, which sets both up, goes once neither is there.
 */
function withCalendarPorts(
  offered: EntryPointsOffered,
  ports: {
    readonly meetings: AppPorts['meetings'] | undefined;
    readonly blocks: AppPorts['blocks'] | undefined;
  },
): EntryPointsOffered {
  const meetingSync = offered.meetingSync && ports.meetings !== undefined;
  const blockSync = offered.blockSync && ports.blocks !== undefined;
  return Object.freeze({
    ...offered,
    meetingSync,
    blockSync,
    googleCalendarSettings: offered.googleCalendarSettings && (meetingSync || blockSync),
  });
}

/** The pages holding a shell now: one each, or two Apps share a root and two guards a window. */
const holding = new WeakSet<Window>();

/** Draws the app into the page's `#root`, as every platform starts it; the answer takes it down again. */
export function mountShell(composition: ShellComposition, page: Window = window): () => void {
  const { ports, offered } = composedForApp(composition);
  const element = page.document.getElementById('root');
  if (!element) throw new Error('index.html is missing #root');
  if (holding.has(page)) throw new Error('this page already holds the app: take it down first');
  holding.add(page);
  const stopGuarding = guardStrayFileDrops(page);
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <App {...ports} offered={offered} />
      {/* What start-up does not draw loads once it has committed, so pages open with no fallback. */}
      <PreloadAfterStart preload={preloadPages} />
    </StrictMode>,
  );
  let down = false;
  // Once only: a teardown run again (a hot reload, a cleanup run twice) must not
  // release the hold of an app mounted after it.
  return () => {
    if (down) return;
    down = true;
    root.unmount();
    stopGuarding();
    holding.delete(page);
  };
}
