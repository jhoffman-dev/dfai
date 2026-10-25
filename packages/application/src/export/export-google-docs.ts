import {
  defaultDriveFolderName,
  driveRetryDelay,
  MAX_GOOGLE_DOC_HTML_BYTES,
  scopesWith,
  type VaultPath,
} from '@dfai/domain';
import type { Wait } from '../granola/granola-requests.ts';
import { GoogleCalendarError, type GoogleCalendarPort } from '../google-calendar/ports.ts';
import type { NotePageRenderer } from '../thumbnails/ports.ts';
import type { ExportReadPorts } from './export-reading.ts';
import { notePage, readNoteToExport } from './note-for-export.ts';
import { ExportError, PartlyExportedError, type GoogleDrivePort } from './ports.ts';

export interface GoogleDocsPorts extends ExportReadPorts {
  readonly renderer: NotePageRenderer;
  /** The Calendar's sign-in, which the export reuses (ADR-0030). */
  readonly google: GoogleCalendarPort;
  readonly drive: GoogleDrivePort;
  /** Waits out a retry's delay: a timer in the app, the test's own clock in a test. */
  readonly wait: Wait;
}

export interface ExportedDocs {
  readonly kind: 'uploaded';
  readonly folder: string;
  readonly documents: readonly { readonly title: string; readonly url: string }[];
  readonly picturesLeftOut: number;
}

const NOT_SET_UP =
  'Google is not connected for this vault. Connect it in Settings → Google Calendar, then export again.';

/**
 * Makes sure the sign-in reaches Drive: once, the person is asked to allow
 * the one more scope (`drive.file`) on top of what they allowed before. The
 * tokens stay with the host; nothing here sees one.
 */
async function ensureDriveAccess(google: GoogleCalendarPort, vault: string): Promise<void> {
  const connection = await google.status({ vault });
  if (!connection.connected || connection.clientId === null) {
    throw new ExportError('google-not-set-up', NOT_SET_UP);
  }
  const scopes = scopesWith(connection.scopes, 'export');
  if (scopes === null) return;
  await google.connect({ vault, clientId: connection.clientId, scopes });
}

/**
 * Each note as a Google Doc in the person's Drive (#501), titled as the
 * note, in the folder named `folderName` — the one this app made before, or
 * a new one. Each is made from the page a PDF is made from, without its
 * script, uploaded as HTML for Google to convert. Nothing in the vault changes.
 */
export async function exportGoogleDocs(
  ports: GoogleDocsPorts,
  {
    vault,
    paths,
    notePaths,
    appName,
  }: {
    vault: string;
    paths: readonly VaultPath[];
    notePaths: readonly VaultPath[];
    /** The app's own name: the default folder is named after it. */
    appName: string;
  },
): Promise<ExportedDocs> {
  if (paths.length === 0) throw new ExportError('failed', 'No notes were chosen to export.');
  const pages = [];
  for (const path of paths) {
    const note = await readNoteToExport(ports, path);
    const page = await notePage(ports, { note, notePaths, script: null });
    if (new TextEncoder().encode(page.html).byteLength > MAX_GOOGLE_DOC_HTML_BYTES) {
      throw new ExportError(
        'too-large',
        `${note.title} is too large for Google Docs: with its pictures it comes to more than 45 MB.`,
      );
    }
    pages.push({ title: note.title, ...page });
  }
  await ensureDriveAccess(ports.google, vault);
  const folder = defaultDriveFolderName(appName);
  const retried = retrying(ports.wait);
  const folderId =
    (await retried(() => ports.drive.findFolder({ vault, name: folder }))) ??
    (await retried(() => ports.drive.createFolder({ vault, name: folder })));
  const documents: { title: string; url: string }[] = [];
  for (const page of pages) {
    try {
      const made = await retried(() =>
        ports.drive.uploadDocument({ vault, title: page.title, html: page.html, folderId }),
      );
      documents.push({ title: page.title, url: made.url });
    } catch (cause) {
      // The Docs made so far are in the Drive: what failed says where they are.
      if (documents.length === 0) throw cause;
      throw new PartlyExportedError({ documents, total: pages.length, folder, cause });
    }
  }
  return {
    kind: 'uploaded',
    folder,
    documents,
    picturesLeftOut: pages.reduce((sum, page) => sum + page.picturesLeftOut, 0),
  };
}

/** The status a Drive call was answered with, when it was answered at all. */
function statusOf(cause: unknown): number | null {
  if (!(cause instanceof GoogleCalendarError) || cause.failure.kind !== 'api_refused') return null;
  const status = Number(cause.failure.code);
  return Number.isInteger(status) ? status : null;
}

/** A Drive call, tried again after the domain's delay while Google says it is only for now. */
function retrying(wait: Wait) {
  return async <T>(call: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await call();
      } catch (cause) {
        const delay = driveRetryDelay({ attempt, status: statusOf(cause) });
        if (delay === null) throw cause;
        await wait(delay);
      }
    }
  };
}
