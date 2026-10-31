import { createStore, type StoreApi } from 'zustand';
import { noteTitle, type VaultPath } from '@dfai/domain';
import {
  ExportError,
  exportGoogleDocs,
  PartlyExportedError,
  exportSummary,
  googleProblemOf,
  GoogleCalendarError,
  saveExport,
  type ActivityLog,
  type ExportOutcome,
  type GoogleDocsPorts,
  type SaveExportPorts,
} from '@dfai/application';
import type { ExportChoice, ExportDialogState } from '@dfai/ui';
import type { BatchAnswer } from '../archive/use-row-selection.ts';
import type { Overlay } from '../overlay.ts';
import type { Toasts } from '../toasts/toasts.ts';

/** The export asked for: which notes, how the dialog stands, and who to tell once it is done. */
export interface ExportFlow {
  readonly paths: readonly VaultPath[];
  /** What the dialog's title names: the note, or "3 notes". */
  readonly subject: string;
  readonly state: ExportDialogState;
}

export interface ExportState {
  readonly flow: ExportFlow | null;
}

export type ExportStore = StoreApi<ExportState>;

export function createExportStore(): ExportStore {
  return createStore<ExportState>()(() => ({ flow: null }));
}

/** What the export reads at the moment it runs: the vault open now, and the window's own. */
export interface ExportDeps {
  readonly ports: SaveExportPorts & GoogleDocsPorts;
  /** The open vault, by the path the host knows it by: what a Google call names. */
  readonly vault: string | null;
  /** The app's own name, which the Google Drive folder is named after. */
  readonly appName: string;
  readonly notePaths: readonly VaultPath[];
  readonly overlay: { show(overlay: Overlay): void; hide(overlay: Overlay): void };
  readonly toasts: Pick<Toasts, 'show'>;
  readonly activity: Pick<ActivityLog, 'record'>;
  readonly openActivity: () => void;
  readonly openLink: (url: string) => void;
}

export interface ExportCommands {
  /** "Export…" from a note's menu, the peek's, ⌘K, or rows chosen in a view. */
  ask(paths: readonly VaultPath[], settled?: (answer: BatchAnswer) => void): void;
  run(choice: ExportChoice): void;
  close(): void;
}

const OVERLAY = 'export-notes';

const subjectOf = (paths: readonly VaultPath[]) =>
  paths.length === 1 ? noteTitle(paths[0]!) : `${paths.length} notes`;

/** What went wrong, in the person's words, and what to do about it. */
function problemOf(cause: unknown): { problem: string; fix: string | null } {
  if (cause instanceof PartlyExportedError) {
    return { problem: cause.message, fix: problemOf(cause.cause).fix };
  }
  if (cause instanceof GoogleCalendarError) return googleProblemOf(cause);
  if (cause instanceof ExportError) return { problem: cause.message, fix: null };
  const message = cause instanceof Error ? cause.message : String(cause);
  return { problem: `The export could not be made: ${message}`, fix: null };
}

/** The export's commands: steady for the store's life, reading `deps()` when they run. */
export function exportCommands(store: ExportStore, deps: () => ExportDeps): ExportCommands {
  let settle: ((answer: BatchAnswer) => void) | null = null;
  const setState = (state: ExportDialogState) => {
    const flow = store.getState().flow;
    if (flow !== null) store.setState({ flow: { ...flow, state } });
  };
  const tellTable = (done: boolean) => {
    const flow = store.getState().flow;
    if (settle === null || flow === null) return;
    settle({ answered: done ? flow.paths : [], failed: done ? [] : flow.paths });
    settle = null;
  };
  const finished = (outcome: ExportOutcome) => {
    const { activity, toasts, openActivity, openLink, overlay } = deps();
    const words = exportSummary(outcome);
    const paths = store.getState().flow?.paths ?? [];
    const [only] = paths.length === 1 ? paths : [];
    activity.record({
      level: 'info',
      kind: 'export',
      message: words,
      subject: only === undefined ? null : { kind: 'note', path: only },
    });
    // One Doc made: the toast opens it. Anything else: where it went is in Activity.
    const [doc, ...more] = outcome.kind === 'uploaded' ? outcome.documents : [];
    toasts.show({
      message: words,
      tone: 'change',
      action:
        doc !== undefined && more.length === 0
          ? { label: 'Open in Google Docs', onClick: () => openLink(doc.url) }
          : { label: 'Activity', onClick: openActivity },
    });
    tellTable(true);
    store.setState({ flow: null });
    overlay.hide(OVERLAY);
  };
  /**
   * An export that failed: said in the dialog, kept in Activity (#502) — and
   * where some Google Docs were made first, each one there to open, and the
   * first a click away in a toast.
   */
  const failed = (cause: unknown) => {
    const { activity, toasts, openLink } = deps();
    const shown = problemOf(cause);
    const paths = store.getState().flow?.paths ?? [];
    const [only] = paths.length === 1 ? paths : [];
    const subject = only === undefined ? null : ({ kind: 'note', path: only } as const);
    activity.record({ level: 'error', kind: 'export', message: shown.problem, subject });
    if (cause instanceof PartlyExportedError) {
      for (const doc of cause.documents) {
        activity.record({
          level: 'info',
          kind: 'export',
          message: `Made the Google Doc “${doc.title}”: ${doc.url}`,
          subject: null,
        });
      }
      const [first] = cause.documents;
      if (first !== undefined) {
        toasts.show({
          message: cause.message,
          tone: 'warning',
          action: { label: 'Open in Google Docs', onClick: () => openLink(first.url) },
        });
      }
    }
    setState({ kind: 'failed', ...shown });
  };
  const exportAs = async (
    paths: readonly VaultPath[],
    choice: ExportChoice,
  ): Promise<ExportOutcome | null> => {
    const { ports, vault, appName, notePaths } = deps();
    if (choice.format === 'google-doc') {
      if (vault === null) throw new ExportError('google-not-set-up', 'Open a vault first.');
      return exportGoogleDocs(ports, { vault, paths, notePaths, appName });
    }
    const saved = await saveExport(ports, {
      format: choice.format,
      paths,
      notePaths,
      keepFrontmatter: choice.keepFrontmatter,
    });
    return saved.kind === 'cancelled' ? null : saved;
  };
  return {
    ask(paths, settled) {
      const unique = [...new Set(paths)];
      if (unique.length === 0) return;
      settle = settled ?? null;
      store.setState({
        flow: { paths: unique, subject: subjectOf(unique), state: { kind: 'choosing' } },
      });
      deps().overlay.show(OVERLAY);
    },
    run(choice) {
      const flow = store.getState().flow;
      if (flow === null || flow.state.kind === 'working') return;
      setState({ kind: 'working', format: choice.format });
      exportAs(flow.paths, choice)
        .then((outcome) => {
          // Cancelled in the save dialog: back to the question, nothing said.
          if (outcome === null) setState({ kind: 'choosing' });
          else finished(outcome);
        })
        .catch((cause: unknown) => failed(cause));
    },
    close() {
      if (store.getState().flow?.state.kind === 'working') return;
      tellTable(false);
      store.setState({ flow: null });
      deps().overlay.hide(OVERLAY);
    },
  };
}
