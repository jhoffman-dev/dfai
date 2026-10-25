import type { ActivityLog } from '../activity/ports.ts';
import type { MeetingDrafts } from '../assistant/meeting-drafts.ts';
import type { ClaudeStepPorts } from '../automations/claude-step.ts';
import type { ImagePlacement, LocalTime, VaultPath } from '@dfai/domain';
import type { HttpPort, SqliteSourcePort } from '../sources/ports.ts';
import type { IndexPort } from '../index/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { ThumbnailQueue } from '../artifacts/thumbnail-queue.ts';
import type { AppInfoPort, Clock, Rng } from '../ports.ts';
import type { GoogleCalendarPort } from '../google-calendar/ports.ts';
import type { PropertyChanges } from '../query/set-property.ts';
import type { SourceRefresher } from '../sources/source-refresher.ts';
import type { TagRenames } from '../tags/index.ts';
import type { LinkUpdatePanes } from '../vault/update-links.ts';
import type { HostVaultFsPort, OpenEditorsPort, VaultLocation } from '../vault/ports.ts';
import type { ApiRequest, ApiResponse } from './contract.ts';
import type { RefreshSpacing } from './refresh-spacing.ts';

/**
 * Whether a pane holds a note, and whether that pane has typing the file does
 * not have yet.
 */
export type OpenNoteState = 'closed' | 'clean' | 'dirty';

/**
 * The notes open in the app's panes, as a request from outside needs to reach
 * them.
 *
 * Writing the file behind an open editor is how edits get lost: the editor
 * still holds the modification time it read, and saves its older copy over the
 * new one (ADR-0016). So a write from outside asks first, and goes through the
 * pane when there is one. The desktop app answers with its pane registry
 * (`apps/desktop/src/panes/open-editors.ts`).
 */
export interface OpenNotes {
  /** `dirty` when any pane holding the note has unsaved edits. */
  state(path: VaultPath): OpenNoteState;
  /**
   * Writes properties through a pane that holds the note, as a board drag does.
   * Settles once that pane's save has landed; false when no pane holds it, and
   * the caller writes the file itself.
   */
  setPropertiesIfOpen(args: { path: VaultPath; values: PropertyChanges }): Promise<boolean>;
  /**
   * Re-reads the note in every pane that holds it and has no unsaved edits,
   * after something outside those panes wrote it.
   */
  reload(path: VaultPath): void;
}

/**
 * The panes, as moving a note from outside reaches them: their typing is
 * written before the file moves, and they follow it to where it went rather
 * than holding a path it has left — as a move made in the app does. The
 * desktop app answers with `movingEditorsIn`.
 */
export type MovingNotes = OpenEditorsPort & Pick<LinkUpdatePanes, 'reload'>;

/** What the app knows about itself that the API reports or is bound by. */
export interface ApiHost {
  /** The vault open right now, or null. The router reads it as a request arrives. */
  currentVault(): VaultLocation | null;
  /** Whether the index has finished building for the open vault. */
  indexReady(): boolean;
}

/** A rule the app's clock has stopped running, and why (A25-01). */
export interface AutomationPause {
  readonly reason: string;
  /** When the clock tries it again; null until it is run by hand. */
  readonly retryAt: LocalTime | null;
}

/** What the app's automation runner holds about a vault that no file says. */
export interface AutomationClockState {
  /** When the runner began watching the vault: what a rule with no log counts its first run from. */
  readonly watchingSince: LocalTime;
  /** The rules its clock is not running just now, by id. */
  readonly pauses: ReadonlyMap<string, AutomationPause>;
}

/**
 * The app's automation runner, as the API reads it. The desktop app answers
 * with its runner's state (`apps/desktop/src/api/automation-relay.ts`).
 */
export interface AutomationClock {
  /** Its state for this vault; null when it is not watching that one (yet). */
  forVault(vault: string): AutomationClockState | null;
}

/** Everything the router needs, as ports. */
export interface ApiRouterDeps {
  readonly host: ApiHost;
  readonly appInfo: AppInfoPort;
  readonly clock: Clock;
  /** Unbound: the router binds it to the vault each request arrives for. */
  readonly fs: HostVaultFsPort;
  readonly markdown: MarkdownPort;
  readonly index: IndexPort;
  readonly openNotes: OpenNotes;
  /** The panes again, for archiving: a move they must follow. */
  readonly movingNotes: MovingNotes;
  /**
   * The app's own index refresh: every note's time and size checked, `recheck`
   * read again whatever they say. Resolves true once the index holds the files.
   * Left out, a request refreshes the index itself.
   */
  readonly indexRefresh?: (recheck: readonly VaultPath[]) => Promise<boolean>;
  /** The app's thumbnail queue, bound to the vault open now. */
  readonly thumbnails: Pick<ThumbnailQueue, 'requestOrFail'>;
  /** Where a source's feeds and files are read from; the host fills in any secret. */
  readonly sources: ApiSourcePorts;
  /** Where Settings → Images puts a note's images, read as each request arrives. */
  readonly imagePlacement: () => ImagePlacement;
  /** The app's one refresher, shared with the panes, so a source never runs twice at once. */
  readonly sourceRefresher: SourceRefresher;
  /** The app's tag renames, shared with the tags page, so two renames in a vault never interleave. */
  readonly tagRenames: TagRenames;
  /** How soon the API may refresh a source it refreshed before. */
  readonly refreshSpacing: RefreshSpacing;
  /** A new id no one can guess, for an image upload staged a chunk at a time. */
  readonly newUploadId: () => string;
  /** Where a new block id is drawn from, when a checklist line is promoted (P30-03). */
  readonly rng: Rng;
  /** The app's automation runner: when it began watching, and which rules it has paused. */
  readonly automationClock: AutomationClock;
  /** Where each write through the API is said, by route and note (U-28). */
  readonly activity: ActivityLog;
  /** Whether Google Calendar is connected; the API reads nothing else of it. */
  readonly googleCalendar: Pick<GoogleCalendarPort, 'status'>;
  /** The IANA zone this Mac keeps time in (`America/Los_Angeles`): a sent meeting's default (#93). */
  readonly timeZone: () => string;
  /**
   * The vault owner's name from Settings → Profile, null when it has none or
   * cannot be read: whose `You` turns in a transcript the assistant's quotes
   * attribute to a person. Left out, no transcript's `You` is anyone's.
   */
  readonly ownerName?: () => string | null;
  /**
   * What drafting a meeting's tasks asks Claude through (P32-05): the
   * provider and model Settings → Claude chose, as a rule's Claude step has
   * them. Null until the app has them; left out, that route answers `conflict`.
   */
  readonly claudeStep?: () => ClaudeStepPorts | null;
  /** The meetings this router is drafting now, so one is drafted once at a time (P32-05). */
  readonly meetingDrafts: MeetingDrafts;
  /** Where the app tells the person something went wrong that no caller is left to hear. */
  readonly notices: AppNotices;
}

/**
 * The app's own word to the person (a toast in the window): for work that
 * outlives the request that started it, such as a draft after its `202`.
 */
export interface AppNotices {
  warn(message: string): void;
}

/** What a source refresh reaches outside the vault through. Never the secret store. */
export interface ApiSourcePorts {
  readonly http: HttpPort;
  readonly sqlite: Pick<SqliteSourcePort, 'query'>;
}

/**
 * Where requests from the host arrive, and where their answers go back.
 *
 * The desktop app answers with Tauri events and a command
 * (`API_REQUEST_EVENT`, `API_RESPOND_COMMAND`); a test answers with a list.
 */
export interface ApiBridgePort {
  /** Hands every request to `answer` and sends back what it settles to, until stopped. */
  serve(answer: (request: ApiRequest) => Promise<ApiResponse>): Promise<() => void>;
}

/** The API's switch and where it can be reached, as Settings shows them. */
export interface ApiConnectionStatus {
  readonly enabled: boolean;
  /** The port listening now, or the one that will be tried first; null before the first start. */
  readonly port: number | null;
  readonly running: boolean;
  /** The connection file other tools read the port and token from. */
  readonly file: string;
}

/** Turning the API on and off, and the token that lets other tools in. */
export interface ApiSettingsPort {
  status(): Promise<ApiConnectionStatus>;
  /** Rejects with why it could not start listening, when it could not. */
  setEnabled(enabled: boolean): Promise<ApiConnectionStatus>;
  token(): Promise<string>;
  /** Replaces the token, so anything holding the old one is refused. Resolves to the new one. */
  rotateToken(): Promise<string>;
}
