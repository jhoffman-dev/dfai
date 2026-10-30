import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GtdStatus, InboxItem, VaultPath } from '@dfai/domain';
import { Icon } from './icon.tsx';
import { InboxRows, type CreateFiling, type InboxRefusal } from './inbox/inbox-rows.tsx';
import type { ClarifyInboxItem } from './inbox/use-inbox-triage.ts';
import { PageAction, PageBar, type PageHistory } from './page-bar.tsx';
import { HiddenTitle } from './page-head.tsx';
import { ROW_SCROLLER_MARK, RowScrollerContext } from './row-scroller.ts';
import {
  proposalsToShow,
  ProposalsSection,
  type ProposalsSectionProps,
} from './proposals/proposals-section.tsx';
import type { RelationChoice } from './properties-panel.tsx';
import { MeetingProjects, type MeetingProjectsProps } from './meeting-projects.tsx';
import { ParaMigration, type ParaMigrationProps } from './para-migration.tsx';
import { TaskMigration, type TaskMigrationProps } from './task-migration.tsx';
import { VaultTidy, type VaultTidyProps } from './vault-tidy.tsx';
import { MeetingCleanup, type MeetingCleanupProps } from './meeting-cleanup.tsx';
import type { InboxOfferReading } from './inbox-offer.ts';
import { useListAnchor, type ListAnchorParts } from './list-anchor.ts';
import { delayedSpinner } from './delayed-spinner.tsx';

const NO_REFUSALS: readonly InboxRefusal[] = [];

/**
 * How long the Inbox holds its rows back for an offer still being read (#130),
 * once none is waiting for the index (that wait has no limit). Most offers are
 * read ahead of the Inbox; the tidy walks the vault as it opens. An offer read
 * later lands above rows already shown, and they are held still as it does.
 *
 * Timed in the page on the 2,000-note fixture, first open: main 72 ms; a
 * 300 ms hold 319 ms, and it still did not keep the heading from moving 68 px
 * when the tidy's walk outlasted it; 100 ms, 117 ms; no hold, 78 ms, but a
 * resize at the top and a vault switch then move what they must not. James
 * may want to revisit it.
 */
export const INBOX_OFFERS_WAIT_MS = 100;

/**
 * The limit instead, on a page that first waited for its vault's index — a
 * vault just opened, or switched to with the Inbox open (#130). Its offers
 * are read only once the index is ready, all at once, so they take longer
 * than an open's; and the list has only just come, so nothing is yet under
 * the pointer to keep waiting from. On CI they outlasted 100 ms.
 */
export const INBOX_OFFERS_AFTER_INDEX_WAIT_MS = 1000;

/**
 * The proposals and rows, laid out as if the wrapper were not there. Held
 * back, they are drawn and measured as usual but not seen and not reached by
 * pointer or keyboard, so they cost no commit of their own when shown (#130).
 * Hidden by a class (`inbox__held`), not `visibility`: see inbox.css.
 */
const IN_PLACE = { display: 'contents' } as const;

/** What the Inbox lists, once it has been read. */
export interface InboxContents {
  readonly items: readonly InboxItem[];
  /** More are waiting than are listed. */
  readonly truncated: boolean;
  /** How many wait in all, listed or not (#167). */
  readonly total: number;
}

/** The offer to set the vault's types up for PARA and the Inbox, with what each gains. */
export interface InboxTypesOffer extends InboxOfferReading {
  readonly lines: readonly string[];
  readonly onAccept: () => void;
  readonly onDismiss: () => void;
}

export interface InboxPageProps {
  /** Null while the index is being asked. */
  contents: InboxContents | null;
  error: string | null;
  /** The projects and areas a note can be filed under. */
  filing: readonly RelationChoice[];
  /**
   * Makes a project or an area of a name no note has, resolving to where it
   * was made (#465); left out, the project picker offers no "Create".
   */
  onCreateFiling?: CreateFiling;
  /** The people a task can wait on. */
  people?: readonly RelationChoice[];
  /** The statuses a row may give a task: the ones the vault's Task type declares. GTD's eight unless said. */
  statuses?: readonly GtdStatus[];
  onOpen: (path: VaultPath) => void;
  /** Lists the next page of what waits, once more wait than are listed (#167). */
  onShowMore: () => void;
  /** Clarifies a note — a task's status, project, wait and dates, or a note's filing (#112). */
  onClarify: ClarifyInboxItem;
  /** While a note is being written, so it is not asked for twice. */
  busy: boolean;
  /** Why the last undo could not be done, or null. */
  problem: string | null;
  /** Why each row's clarification was refused, shown on that row, until it is clarified again. */
  refusals?: readonly InboxRefusal[];
  /** Why each imported meeting's summary still waits, by path; a meeting not in it waits for none (#186). */
  summaryPending?: ReadonlyMap<string, string>;
  typesOffer?: InboxTypesOffer | null;
  /** Moving the vault's tasks to GTD's eight statuses, previewed first (P30-02). */
  taskMigration?: TaskMigrationProps | null;
  /** Moving the vault's Area and Resource notes onto the Project type, previewed first (#213). */
  paraMigration?: ParaMigrationProps | null;
  /** Moving loose notes and old meetings to their home folders, once, previewed first (#214). */
  vaultTidy?: VaultTidyProps | null;
  /**
   * Set while a rule would make the owner's tasks from meetings but the vault
   * does not say who the owner is (#181): no task can be made until it does.
   */
  ownerUnknown?: { readonly onOpenSettings: () => void } | null;
  /**
   * Set while the vault's settings note cannot be read (#226): who the owner
   * is is not known, so the meeting import and the automations are held
   * until it reads. `problem` is why it cannot be read.
   */
  settingsUnreadable?: { readonly problem: string; readonly onOpenSettings: () => void } | null;
  /**
   * On a Mac that is not named, what waits for the one that is (ADR-0035
   * part 1): "N meetings waiting for <Mac>", or, before a count can be given,
   * what it waits for, with "Process here" (part 2). Null on the named Mac,
   * and when none waits.
   */
  meetingsWaiting?: MeetingsWaitingProps | null;
  /** The tasks meetings made that today's rules would not have, offered to archive (#226). */
  meetingCleanup?: MeetingCleanupProps | null;
  /** Filing the meetings that have no project as their series is, previewed first (#227). */
  meetingProjects?: MeetingProjectsProps | null;
  /** The vault's own Inbox view, which the sidebar's Inbox row opened before this page. */
  view?: { readonly title: string; readonly onOpen: () => void } | null;
  /** What Claude or an automation proposed, answered here rather than filed (P29-02). */
  proposals?: ProposalsSectionProps | null;
  onShowSidebar?: () => void;
  history?: PageHistory;
}

/**
 * The Inbox: every note waiting in the `Inbox` folder — captured or dropped
 * there — every task still at the Inbox status and every imported meeting not
 * filed yet, wherever each lives, each a click from opening. A task is
 * clarified on its row (#112); any other note is one choice from being filed
 * under a project or an area, which links it (P30-01, #214). Proposals wait there too, and are answered in their own
 * section rather than filed (P29-02). A meeting the import is waiting on, or
 * could not import, says so on its row (P28-04).
 */
export function InboxPage(props: InboxPageProps) {
  const view = props.view ?? null;
  const offer = props.typesOffer ?? null;
  const migration = props.taskMigration ?? null;
  const paraMigration = props.paraMigration ?? null;
  const tidy = props.vaultTidy ?? null;
  const ownerUnknown = props.ownerUnknown ?? null;
  const settingsUnreadable = props.settingsUnreadable ?? null;
  const meetingsWaiting = props.meetingsWaiting ?? null;
  const cleanup = props.meetingCleanup ?? null;
  const meetingProjects = props.meetingProjects ?? null;
  const proposals = props.proposals ?? null;
  const problem = props.problem ?? leftRefusal(props);
  const counted = describe(props.contents, proposals?.contents?.open.length ?? 0);
  const scroller = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const answers = useRef<HTMLDivElement>(null);
  const room = useRef<HTMLDivElement>(null);
  const parts = useMemo<ListAnchorParts>(
    () => ({ scroller, page: article, list, answers, room }),
    [],
  );
  const offersRead = [offer, migration, paraMigration, tidy, cleanup, meetingProjects];
  const live = useOffersKnown(
    offersRead.some((read) => read?.reading === true),
    offersRead.some((read) => read?.waitingForIndex === true),
  );
  const anchor = useListAnchor(parts, live);
  return (
    <>
      <PageBar
        crumb={{ icon: 'inbox', parent: 'Inbox' }}
        name="To process"
        {...(counted !== null && { count: counted })}
        {...(view !== null && {
          actions: (
            <PageAction icon="table" label={`Open the ${view.title} view`} onPress={view.onOpen} />
          ),
        })}
        {...(props.onShowSidebar !== undefined && { onShowSidebar: props.onShowSidebar })}
        {...(props.history !== undefined && { history: props.history })}
      />
      <NewAbove {...anchor} />
      <div
        className="panel__body panel__body--rows"
        style={NOT_ANCHORED}
        ref={scroller}
        {...ROW_SCROLLER_MARK}
      >
        <RowScrollerContext.Provider value={scroller}>
          <article className="page page--wide inbox" aria-label="Inbox" ref={article}>
            <HiddenTitle>To process</HiddenTitle>
            {settingsUnreadable !== null && <SettingsUnreadable {...settingsUnreadable} />}
            {ownerUnknown !== null && <OwnerUnknown {...ownerUnknown} />}
            {meetingsWaiting !== null && <MeetingsWaiting {...meetingsWaiting} />}
            <Offers
              offers={[
                slot('types', offer, (known) => <TypesOffer {...known} />),
                slot('tasks', migration, (known) => <TaskMigration {...known} />),
                slot('para', paraMigration, (known) => <ParaMigration {...known} />),
                slot('tidy', tidy, (known) => <VaultTidy {...known} />),
                slot('cleanup', cleanup, (known) => <MeetingCleanup {...known} />),
                slot('meetings', meetingProjects, (known) => <MeetingProjects {...known} />),
              ]}
            />
            <div style={IN_PLACE} ref={answers}>
              {problem !== null && (
                <p className="table__error" role="alert">
                  {problem}
                </p>
              )}
            </div>
            <div
              style={IN_PLACE}
              className={live ? undefined : 'inbox__held'}
              inert={!live}
              aria-hidden={live ? undefined : true}
              ref={list}
            >
              {proposals !== null && proposalsToShow(proposals) && (
                <ProposalsSection {...proposals} />
              )}
              <InboxList {...props} />
            </div>
          </article>
          <div ref={room} style={ROOM} aria-hidden="true" />
        </RowScrollerContext.Provider>
      </div>
    </>
  );
}

/** One offer's slot: drawn once it is known, null while it is still read. */
type OfferSlot = readonly [key: string, offer: ReactNode];

function slot<Offer extends InboxOfferReading>(
  key: string,
  offer: Offer | null,
  draw: (known: Offer) => ReactNode,
): OfferSlot {
  return [key, offer === null || offer.reading === true ? null : draw(offer)];
}

/**
 * Says that something arrived above the list while the person was on it, and
 * takes them to it (#130). It hangs over the top of the page rather than
 * taking room, so saying so moves nothing; the region is always there, so a
 * screen reader hears it arrive.
 */
const NewAbove = memo(function NewAbove({
  newAbove,
  showNewAbove,
}: {
  newAbove: boolean;
  showNewAbove: () => void;
}) {
  return (
    <div style={NEW_ABOVE_HANGER} aria-live="polite">
      {newAbove && (
        <button
          type="button"
          className="btn btn--sm"
          style={NEW_ABOVE_BUTTON}
          onClick={showNewAbove}
        >
          <span aria-hidden="true">↑</span> New above
        </button>
      )}
    </div>
  );
});

/**
 * The browser does not anchor the Inbox's scroller: the list anchor does, and
 * with both, each move would be corrected twice (WebKit supports
 * `overflow-anchor`, and its `auto` held the rows the other way).
 */
const NOT_ANCHORED = { overflowAnchor: 'none' } as const;
/** The room the list anchor gives below the page; its height is set there, never here. */
const ROOM = { flexShrink: 0 } as const;
const NEW_ABOVE_HANGER = { position: 'relative', height: 0, zIndex: 2 } as const;
const NEW_ABOVE_BUTTON = {
  position: 'absolute',
  top: 8,
  left: '50%',
  transform: 'translateX(-50%)',
  boxShadow: 'var(--shadow-panel)',
} as const;

/**
 * Whether the Inbox's offers are known, so its rows can be drawn below them
 * (#130): once none is still being read, or once it has waited for one —
 * counted only once none is waiting for the index, since until then the list
 * has no rows either, and for longer on a page that did wait for it. Known
 * stays known while the page shows.
 */
function useOffersKnown(reading: boolean, waitingForIndex: boolean): boolean {
  const [offersKnown, setOffersKnown] = useState(!reading);
  const [waitedForIndex, setWaitedForIndex] = useState(waitingForIndex);
  if (!reading && !offersKnown) setOffersKnown(true);
  if (waitingForIndex && !waitedForIndex) setWaitedForIndex(true);
  useEffect(() => {
    if (offersKnown || waitingForIndex) return;
    const limit = waitedForIndex ? INBOX_OFFERS_AFTER_INDEX_WAIT_MS : INBOX_OFFERS_WAIT_MS;
    const timer = setTimeout(() => setOffersKnown(true), limit);
    return () => clearTimeout(timer);
  }, [offersKnown, waitingForIndex, waitedForIndex]);
  return offersKnown;
}

/**
 * The Inbox's offers, each read on its own and shown once it is (#227). One
 * read after the others goes below those already shown, and one shown keeps
 * its place for as long as the page shows — read as nothing for a moment as
 * its run settles, it comes back where it was.
 */
function Offers({ offers }: { offers: readonly OfferSlot[] }) {
  const shown = offers.filter(([, offer]) => offer !== null);
  const [order, setOrder] = useState<readonly string[]>(() => shown.map(([key]) => key));
  const next = inArrivalOrder(
    order,
    shown.map(([key]) => key),
  );
  if (next.join('\n') !== order.join('\n')) setOrder(next);
  const byKey = new Map(shown);
  return next.flatMap((key) => {
    const offer = byKey.get(key);
    return offer === undefined ? [] : [<Fragment key={key}>{offer}</Fragment>];
  });
}

/** The offers shown before, in their order, then each newly shown one, in the order given. */
function inArrivalOrder(before: readonly string[], shown: readonly string[]): readonly string[] {
  return [...before, ...shown.filter((key) => !before.includes(key))];
}

/** What waits, in a few words beside the page's name; nothing when nothing does. */
function describe(contents: InboxContents | null, proposals: number): string | null {
  if (contents === null) return null;
  const toAnswer = proposals === 0 ? '' : ` · ${proposals} to answer`;
  if (contents.total === 0) return proposals === 0 ? null : `${proposals} to answer`;
  return `${contents.total} to process${toAnswer}`;
}

/**
 * Said for as long as it is so (#181): with no name or address to know the
 * owner by, no meeting's item can be known to be theirs, so none is made a task.
 */
function OwnerUnknown({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <aside
      className="notice-bar inbox__offer inbox__offer--warning"
      role="alert"
      aria-label="DFAI can’t tell which action items are yours"
    >
      <Icon name="person" size={14} className="notice-bar__icon" />
      <div className="notice-bar__text">
        <p>
          DFAI can’t tell which action items are yours, so meetings make no tasks for you. Add your
          name or your emails in Settings → Profile.
        </p>
      </div>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onOpenSettings}>
        Open Settings
      </button>
    </aside>
  );
}

/** "Process here" on the banner: the claim, and what the page shows of it. */
export interface ProcessHereProps {
  /** Why it cannot be pressed now (sync paused, failing, not pulled); null when it can. */
  readonly refused: string | null;
  /** Whether a press is being written. */
  readonly busy: boolean;
  /** Why the last press named no Mac; null when it did, or none was made. */
  readonly problem: string | null;
  readonly onPress: () => void;
}

/** What waits for the named Mac, on another Mac, and the way to take it (ADR-0035 parts 1 and 2). */
export interface MeetingsWaitingProps {
  readonly line: string;
  /** Null until sync says where the vault stands. */
  readonly processHere: ProcessHereProps | null;
}

/** What waits for the Mac that runs the automations, on another Mac (ADR-0035 part 1). */
function MeetingsWaiting({ line, processHere }: MeetingsWaitingProps) {
  const why = processHere?.refused ?? processHere?.problem ?? null;
  return (
    <aside
      className="notice-bar inbox__offer inbox__offer--warning"
      role="status"
      aria-label="Meetings waiting"
    >
      <Icon name="event" size={14} className="notice-bar__icon" />
      <div className="notice-bar__text">
        <p>{line}</p>
        {why !== null && <p className="notice-bar__why">{why}</p>}
      </div>
      {processHere !== null && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={processHere.refused !== null || processHere.busy}
          onClick={processHere.onPress}
        >
          {processHere.busy ? 'Processing…' : 'Process here'}
        </button>
      )}
    </aside>
  );
}

/**
 * Said for as long as the vault's settings note cannot be read (#226): the
 * meeting import and the automations wait, losing nothing, until it reads.
 */
function SettingsUnreadable({
  problem,
  onOpenSettings,
}: {
  problem: string;
  onOpenSettings: () => void;
}) {
  return (
    <aside
      className="notice-bar inbox__offer inbox__offer--warning"
      role="alert"
      aria-label="Meetings and automations are paused"
    >
      <Icon name="person" size={14} className="notice-bar__icon" />
      <div className="notice-bar__text">
        <p>
          Meetings and automations are paused: .atlas/settings.md can’t be read ({problem}). Nothing
          is lost — meetings wait in their folder — and both resume once it reads.
        </p>
      </div>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onOpenSettings}>
        Open Settings
      </button>
    </aside>
  );
}

function TypesOffer({ lines, onAccept, onDismiss }: InboxTypesOffer) {
  return (
    <aside className="notice-bar inbox__offer" aria-label="Set your types up for the Inbox">
      <Icon name="link" size={14} className="notice-bar__icon" />
      <div className="notice-bar__text">
        <p>
          Notes are filed under a project or an area, and proposals and meetings arrive here. Your
          types could hold what that needs:
        </p>
        <ul>
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <button type="button" className="btn btn--secondary btn--sm" onClick={onAccept}>
        Add to the types
      </button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onDismiss}>
        Not now
      </button>
    </aside>
  );
}

/** The refusals whose rows have left the list — clarified, but not filed — which the page says instead. */
function leftRefusal({ contents, refusals = NO_REFUSALS }: InboxPageProps): string | null {
  const listed = new Set(contents?.items.map((item: InboxItem) => item.path));
  const left = refusals.filter((refusal) => !listed.has(refusal.path));
  return left.length === 0 ? null : left.map((refusal) => refusal.reason).join(' ');
}

function InboxList({
  contents,
  error,
  filing,
  onCreateFiling,
  people = [],
  statuses,
  onOpen,
  onShowMore,
  onClarify,
  busy,
  refusals = NO_REFUSALS,
  summaryPending,
}: InboxPageProps) {
  const stranded = useRef<VaultPath | null>(null);
  if (error !== null) {
    return (
      <p className="table__error" role="alert">
        {error}
      </p>
    );
  }
  if (contents === null) return delayedSpinner('Reading the Inbox…');
  if (contents.items.length === 0) {
    return (
      <p className="inbox__empty">
        Nothing is waiting. Captured tasks (⇧⌘N) and imported meetings arrive here.
      </p>
    );
  }
  return (
    <div className="table inbox__list">
      <h2 className="inbox__section">
        To clarify <span className="inbox__section-count">{contents.total}</span>
        <span className="inbox__section-hint">
          New tasks land here with status Inbox. Nothing is required.
        </span>
      </h2>
      <div className="table__sheet">
        <table className="table__grid inbox__grid" aria-rowcount={contents.items.length + 1}>
          <thead>
            <tr aria-rowindex={1}>
              <th>Name</th>
              <th>Kind</th>
              <th>
                <span className="visually-hidden">Clarify</span>
              </th>
              <th>
                <span className="visually-hidden">Keys</span>
              </th>
            </tr>
          </thead>
          <InboxRows
            items={contents.items}
            filing={filing}
            {...(onCreateFiling !== undefined && { onCreateFiling })}
            people={people}
            {...(statuses !== undefined && { statuses })}
            onOpen={onOpen}
            onClarify={onClarify}
            busy={busy}
            refusals={refusals}
            {...(summaryPending !== undefined && { summaryPending })}
            stranded={stranded}
          />
        </table>
        {contents.truncated && (
          <footer className="table__footer">
            <span className="table__count">
              Showing the newest {contents.items.length} of {contents.total}.
            </span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={onShowMore}>
              Show more
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
