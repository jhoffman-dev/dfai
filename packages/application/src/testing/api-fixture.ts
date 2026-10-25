import { recordingActivity } from './fake-activity.ts';
import { fakeGoogleCalendar } from './fake-google-calendar.ts';
import {
  createVaultPath,
  type EntryMove,
  type HttpRequest,
  type ImagePlacement,
  type VaultEntry,
  type VaultPath,
} from '@dfai/domain';
import type { ApiRequest, ApiResponse } from '../api/contract.ts';
import type { ApiRouterDeps, AutomationClockState } from '../api/ports.ts';
import { createRefreshSpacing } from '../api/refresh-spacing.ts';
import { routeApiRequest } from '../api/router.ts';
import { generateArtifactThumbnail } from '../artifacts/artifact-thumbnail.ts';
import type { PageSnapshotPort } from '../artifacts/ports.ts';
import { createThumbnailQueue, type ThumbnailQueue } from '../artifacts/thumbnail-queue.ts';
import { setNoteProperties } from '../query/set-property.ts';
import { createSourceRefresher } from '../sources/source-refresher.ts';
import { createTagRenames } from '../tags/index.ts';
import { inVault } from '../vault/in-vault.ts';
import type { IndexPort } from '../index/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import {
  VaultAccessError,
  type HostVaultFsPort,
  type VaultFsPort,
  type VaultLocation,
} from '../vault/ports.ts';
import { createMeetingDrafts } from '../assistant/meeting-drafts.ts';
import type { ClaudeStepPorts } from '../automations/claude-step.ts';
import { fakeIndexPort, fakeMarkdown, fakeOpenNotes } from './fake-ports.ts';

/*
 * A vault held in memory, behind the ports the API router needs, for the
 * router's tests. It behaves as the host does where the router depends on it:
 * a missing note is a `VaultAccessError`, a create never overwrites nor makes
 * the folder it is in (the vault's folders are the ones its files sit in), a write
 * is refused when the note changed since `expectedModified`, and any write
 * naming a vault other than the open one is refused (R14-01). With
 * `caseInsensitive` it finds a note however its path is cased or normalized,
 * as APFS does, and keeps the spelling the note already has.
 */

export const VAULT: VaultLocation = { absolutePath: '/Users/j/Vault', name: 'Vault' };
export const OTHER_VAULT: VaultLocation = { absolutePath: '/Users/j/Other', name: 'Other' };
export const TODAY = '2026-09-22';
/** The fixture clock's now, in milliseconds: 2026-09-22 at 09:00 UTC. */
export const NOW = Date.UTC(2026, 8, 22, 9);

/** What the fixture's snapshot pictures every page as: the smallest thing that is a PNG. */
export const FAKE_PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);

interface StoredNote {
  text: string;
  modified: number;
}

export interface ApiFixture {
  readonly files: Map<string, StoredNote>;
  /** Files that are not notes — an artifact's saved copy — by path. */
  readonly binaries: Map<string, Uint8Array>;
  /** Folders made through the API; the others are the ones its files sit in. */
  readonly folders: Set<string>;
  /** Every write that landed, in order. */
  readonly writes: { path: string; contents: string }[];
  /** Every move the panes were told to follow, in order. */
  readonly followed: EntryMove[];
  /** Every set of notes the panes were asked to write their typing for, in order. */
  readonly flushed: (readonly VaultPath[])[];
  /** Which vault is open; tests switch it to model a vault change mid-request. */
  open: VaultLocation | null;
  /** The clock's now, in milliseconds; tests move it on. Starts at `NOW`. */
  now: number;
  indexReady: boolean;
  /** The zone the Mac keeps time in; tests move it. Starts at `America/Los_Angeles`. */
  timeZone: string;
  /** The app's today, `YYYY-MM-DD`; starts at `TODAY`, tests move it. */
  today: string;
  /** The vault owner's name from the profile; null (none) to start, tests set it. */
  ownerName: string | null;
  /** What drafting a meeting's tasks asks Claude through; none to start, tests set it. */
  claudeStep: ClaudeStepPorts | null;
  /** What the app told the person in a notice, in order. */
  readonly notices: string[];
  /** Pictures every page; a test swaps it to make pictures fail. */
  snapshot: PageSnapshotPort;
  /** Every request a source refresh handed the host, with the vault it named. */
  readonly fetches: { request: HttpRequest; vault: string }[];
  /** Every SQLite query a source refresh handed the host. */
  readonly sqliteQueries: { file: string; sql: string }[];
  /** What the host answers a feed with; a test swaps it for the feed it needs. */
  feed: (request: HttpRequest) => Promise<string>;
  /** Where Settings → Images puts images; a test switches it. */
  placement: ImagePlacement;
  /** The app's shared thumbnail queue, as the gallery sees it. */
  readonly thumbnails: ThumbnailQueue;
  deps: ApiRouterDeps;
  /** The app's automation runner, by the vault it watches; none until a test says so. */
  readonly automations: Map<string, AutomationClockState>;
  /** The vault as a use-case called directly sees it: bound to the vault opened first. */
  readonly fs: VaultFsPort;
  /** What the router and the refresher said in the Activity log. */
  readonly activity: ReturnType<typeof recordingActivity>;
  /** Google Calendar's sign-ins, by vault, as the host keeps them. */
  readonly google: ReturnType<typeof fakeGoogleCalendar>;
  send(request: Partial<ApiRequest> & Pick<ApiRequest, 'method' | 'path'>): Promise<ApiResponse>;
}

export function apiFixture({
  files = {},
  index = {},
  markdown = fakeMarkdown(),
  caseInsensitive = false,
}: {
  files?: Record<string, string>;
  index?: Partial<IndexPort>;
  markdown?: MarkdownPort;
  caseInsensitive?: boolean;
} = {}): ApiFixture {
  let clock = 100;
  const stored = new Map(
    Object.entries(files).map(([path, text]) => [path, { text, modified: (clock += 1) }]),
  );
  const binaries = new Map<string, Uint8Array>();
  const folders = new Set<string>();
  let uploads = 0;
  const activity = recordingActivity();
  const google = fakeGoogleCalendar();
  const state = {
    open: VAULT as VaultLocation | null,
    now: NOW,
    indexReady: true,
    timeZone: 'America/Los_Angeles',
    today: TODAY,
    ownerName: null as string | null,
    claudeStep: null as ClaudeStepPorts | null,
    notices: [] as string[],
    writes: [] as { path: string; contents: string }[],
    followed: [] as EntryMove[],
    flushed: [] as (readonly VaultPath[])[],
  };

  // As the host does: a write is refused unless the vault it names is still
  // the one open (R14-01); every write names one (R14-04).
  const refuseOtherVault = (vault: string) => {
    if (state.open === null) throw new VaultAccessError('no vault is open');
    if (vault !== state.open.absolutePath) {
      throw new VaultAccessError('that vault is not open');
    }
  };
  const fold = (path: string) => path.normalize('NFC').toLowerCase();
  /** The stored path a request for `path` reaches: itself, unless the disk ignores case. */
  const located = (path: string): string => {
    if (!caseInsensitive || stored.has(path)) return path;
    return [...stored.keys()].find((key) => fold(key) === fold(path)) ?? path;
  };
  const allPaths = () => [...stored.keys(), ...binaries.keys(), ...folders];
  const folderExists = (folder: string): boolean =>
    folder === '' ||
    folders.has(folder) ||
    allPaths().some((key) =>
      caseInsensitive ? fold(key).startsWith(`${fold(folder)}/`) : key.startsWith(`${folder}/`),
    );
  const read = (path: string): StoredNote => {
    const note = stored.get(located(path));
    if (note === undefined) throw new VaultAccessError('no such entry');
    return note;
  };

  // As the host does: offset 0 creates and never overwrites; past 0 appends to
  // a file that must be exactly that long; `replace` writes a file whole.
  const writeBinaryFile: HostVaultFsPort['writeBinaryFile'] = async ({
    path,
    bytes,
    offset,
    replace = false,
    vault,
  }) => {
    refuseOtherVault(vault);
    const held = binaries.get(path);
    if (replace) {
      if (offset !== 0 || stored.has(path) || folders.has(path)) {
        throw new VaultAccessError('cannot replace that');
      }
      if (!folderExists(path.split('/').slice(0, -1).join('/'))) {
        throw new VaultAccessError('that folder does not exist');
      }
      binaries.set(path, bytes.slice());
      return bytes.byteLength;
    }
    if (offset === 0) {
      if (held !== undefined || stored.has(path))
        throw new VaultAccessError('that file already exists');
      if (!folderExists(path.split('/').slice(0, -1).join('/'))) {
        throw new VaultAccessError('that folder does not exist');
      }
    } else if (held === undefined || held.byteLength !== offset) {
      throw new VaultAccessError('the file is not the length the write expected');
    }
    const joined = new Uint8Array(offset + bytes.byteLength);
    if (held !== undefined) joined.set(held);
    joined.set(bytes, offset);
    binaries.set(path, joined);
    return joined.byteLength;
  };

  const fs: HostVaultFsPort = {
    // As the host does, a file is listed with its size, and a folder that is
    // not there cannot be listed.
    listDirectory: async (folder) => {
      if (!folderExists(folder)) throw new VaultAccessError('no such folder');
      return childrenOf({ paths: allPaths(), folders, folder }).map((entry) => {
        const bytes = binaries.get(entry.path);
        return entry.kind === 'file' && bytes !== undefined
          ? { ...entry, size: bytes.byteLength }
          : entry;
      });
    },
    listFiles: async () => [],
    listNotes: async () =>
      [...stored].map(([path, note]) => ({
        name: path.split('/').at(-1) ?? '',
        path: createVaultPath(path),
        modified: note.modified,
        size: note.text.length,
      })),
    // Any file reads as text, as the host's does.
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const bytes = binaries.get(path);
        if (bytes !== undefined) {
          const text = new TextDecoder().decode(bytes);
          return [{ path, text, modified: 0, size: bytes.byteLength }];
        }
        const note = stored.get(located(path));
        return note === undefined ? [] : [{ path, ...note, size: note.text.length }];
      }),
    // Any file reads as text, as the host's does: a copy's page as well as a note.
    readTextFile: async (path) => {
      const bytes = binaries.get(path);
      if (bytes !== undefined) return { text: new TextDecoder().decode(bytes), modified: 0 };
      return { ...read(path) };
    },
    readBinaryFile: async (path) => {
      const bytes = binaries.get(path);
      if (bytes === undefined) throw new VaultAccessError('no such entry');
      return bytes.slice().buffer;
    },
    createNote: async ({ path, contents, vault }) => {
      refuseOtherVault(vault);
      if (!folderExists(path.split('/').slice(0, -1).join('/'))) {
        throw new VaultAccessError('that folder does not exist');
      }
      if (stored.has(located(path))) {
        throw new VaultAccessError('a note with that name already exists');
      }
      const modified = (clock += 1);
      stored.set(path, { text: contents, modified });
      state.writes.push({ path, contents });
      return modified;
    },
    createFolder: async ({ path, vault }) => {
      refuseOtherVault(vault);
      if (!folderExists(path.split('/').slice(0, -1).join('/'))) {
        throw new VaultAccessError('that folder does not exist');
      }
      if (allPaths().includes(path)) throw new VaultAccessError('that name is taken');
      folders.add(path);
    },
    // The API moves two things: a finished upload out of its staging file,
    // and a note into or out of the Archive.
    moveEntry: async ({ from, to, vault }) => {
      refuseOtherVault(vault);
      const bytes = binaries.get(from);
      const note = stored.get(located(from));
      const staged = from.startsWith('.atlas-cache/uploads/') && bytes !== undefined;
      if (!staged && note === undefined) throw new VaultAccessError('no such entry');
      const taken = (path: string) => (caseInsensitive ? fold(path) === fold(to) : path === to);
      if (allPaths().some(taken)) {
        throw new VaultAccessError('something is already there');
      }
      if (!folderExists(to.split('/').slice(0, -1).join('/'))) {
        throw new VaultAccessError('that folder does not exist');
      }
      if (staged) {
        binaries.delete(from);
        binaries.set(to, bytes);
        return;
      }
      stored.delete(located(from));
      stored.set(to, { text: note?.text ?? '', modified: (clock += 1) });
    },
    trashEntry: async () => {
      throw new Error('the API never deletes');
    },
    writeTextFile: async ({ path, contents, expectedModified, vault }) => {
      refuseOtherVault(vault);
      if (expectedModified !== null && read(path).modified !== expectedModified) {
        throw new VaultAccessError('the note changed on disk since it was opened');
      }
      const modified = (clock += 1);
      stored.set(located(path), { text: contents, modified });
      state.writes.push({ path, contents });
      return modified;
    },
    writeBinaryFile,
  };

  // As the app's queue is: bound to the vault open, writing the cover as any write does.
  const thumbnails = createThumbnailQueue({
    generate: ({ path, asked }) => {
      const bound = inVault({ fs, vault: state.open?.absolutePath ?? '' });
      return generateArtifactThumbnail({
        fs: bound,
        markdown,
        snapshot: fixture.snapshot,
        notePath: path,
        asked,
        setProperties: (values) =>
          setNoteProperties({ fs: bound, markdown, path, values, today: TODAY }),
      });
    },
  });
  const deps: ApiRouterDeps = {
    host: { currentVault: () => state.open, indexReady: () => state.indexReady },
    appInfo: { read: async () => ({ name: 'DFAI', version: '1.4.0', build: '0a1b2c3' }) },
    clock: {
      today: () => state.today,
      now: () => state.now,
      localNow: () => `${state.today}T09:00:00`,
    },
    fs,
    markdown,
    index: fakeIndexPort(index),
    openNotes: fakeOpenNotes(),
    movingNotes: {
      state: () => 'closed',
      flush: async (paths) => {
        state.flushed.push(paths);
      },
      follow: (move) => state.followed.push(move),
      abandon: () => {},
      reload: () => {},
    },
    thumbnails,
    sources: {
      http: {
        get: (args) => {
          fixture.fetches.push(args);
          return fixture.feed(args.request);
        },
      },
      sqlite: {
        query: async (query) => {
          fixture.sqliteQueries.push(query);
          throw new Error('no SQLite file in this fixture');
        },
      },
    },
    imagePlacement: () => fixture.placement,
    sourceRefresher: createSourceRefresher({ activity }),
    tagRenames: createTagRenames(),
    refreshSpacing: createRefreshSpacing(),
    newUploadId: () => `upload-${(uploads += 1)}`,
    rng: { next: () => 0.5 },
    automationClock: {
      forVault: (vault) => fixture.automations.get(vault) ?? null,
    },
    activity,
    googleCalendar: google.port,
    timeZone: () => state.timeZone,
    ownerName: () => state.ownerName,
    claudeStep: () => state.claudeStep,
    meetingDrafts: createMeetingDrafts(),
    notices: { warn: (message) => state.notices.push(message) },
  };
  const fixture: ApiFixture = Object.assign(state, {
    automations: new Map<string, AutomationClockState>(),
    files: stored,
    binaries,
    folders,
    snapshot: { capture: async () => FAKE_PNG } as PageSnapshotPort,
    fetches: [],
    sqliteQueries: [],
    feed: async () => '[]',
    placement: 'attachments' as ImagePlacement,
    thumbnails,
    deps,
    fs: inVault({ fs, vault: VAULT.absolutePath }),
    activity,
    google,
    send: (request: Partial<ApiRequest> & Pick<ApiRequest, 'method' | 'path'>) =>
      routeApiRequest({ id: 'r1', query: {}, body: null, ...request }, fixture.deps),
  });
  return fixture;
}

/** The files and folders directly inside `folder`, from a flat list of paths and the folders made. */
function childrenOf({
  paths,
  folders,
  folder,
}: {
  paths: readonly string[];
  folders: ReadonlySet<string>;
  folder: VaultPath;
}): VaultEntry[] {
  const prefix = folder === '' ? '' : `${folder}/`;
  const children = new Map<string, VaultEntry>();
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const [name = '', ...rest] = path.slice(prefix.length).split('/');
    const child = createVaultPath(prefix + name);
    const isFolder = rest.length > 0 || folders.has(child);
    children.set(name, { kind: isFolder ? 'directory' : 'file', name, path: child });
  }
  return [...children.values()];
}

/** The success body of a response, typed loosely for reading in assertions. */
export function bodyOf(response: ApiResponse): Record<string, unknown> {
  return response.body as unknown as Record<string, unknown>;
}

/** The error code of a response, or null when it succeeded. */
export function codeOf(response: ApiResponse): string | null {
  const body = response.body as { error?: { code: string } };
  return body.error?.code ?? null;
}

/** A path as the URL carries it: one segment, slashes and all encoded. */
export function encoded(path: string): string {
  return encodeURIComponent(path);
}
