import { useEffect, useRef, useState } from 'react';
import {
  NO_POST_PROCESSING,
  type MeetingsWaiting,
  type PostProcessingLedger,
  type PullStanding,
  type VaultPath,
} from '@dfai/domain';
import {
  createMeetingImporter,
  createMeetingLinker,
  importMeetingsOnArrival,
  type ActivityLog,
  type Clock,
  type MeetingImporter,
  type MeetingImportPorts,
  type NoteChanges,
} from '@dfai/application';
import type { PulledFilesGate } from '../sync/use-pulled-files.ts';

/**
 * Imports meetings (P28-04): every refresh of the index says which notes it
 * found, and the meeting files among them are settled; and once the index is
 * ready, every meeting file not settled yet is. Each meeting let in is
 * linked to its people, companies and likely project (P29-04) — once, just
 * before the write that corrects and stamps it. The rules are the
 * use-cases'; this connects them to the window.
 *
 * Only on the Mac that runs the vault's automations (`active`), so two Macs
 * never write the same file, and only on fresh sync state: each run asks the
 * gates of ADR-0035 part 4 as its turn comes, and again for each file right
 * before each write. It catches up after each pull completes there, which
 * settles whatever it dropped while they were shut, and when this Mac takes
 * the automations over.
 *
 * On a Mac that is not named it imports nothing and is not silent (ADR-0035
 * parts 1 and 3): once per pull it counts what waits for the named Mac, says
 * it through `onWaiting` for the Inbox, and warns in Activity.
 *
 * One importer for the window, so its queue is not lost. The ports, the open
 * vault, `active` and what to do after a write change more often — the ports
 * on every folder opened or closed — and are read as each run starts.
 */
export function useMeetingImport({
  changes,
  ports,
  clock,
  activity,
  vaultKey,
  active,
  indexReady,
  selfName,
  selfEmails,
  ownerKnown,
  pulledFiles,
  namedElsewhere,
  onWaiting,
  onWritten,
  postProcessing = NO_NEWS,
}: {
  changes: NoteChanges;
  ports: MeetingImportPorts;
  clock: Pick<Clock, 'today'>;
  activity: ActivityLog;
  vaultKey: string | null;
  /** Whether this Mac imports: it runs the vault's automations. */
  active: boolean;
  /**
   * Whether the index is ready, which the import asks who holds a meeting.
   * Only a ready seen after the vault opened counts: the window's status is
   * the last vault's until the new one's sync starts.
   */
  indexReady: boolean;
  /** The vault owner's name, from their profile: an attendee of that name is never proposed as someone new. */
  selfName: string | null;
  /** The vault owner's own addresses, its `selfEmails`: an attendee at one is never proposed as someone new. */
  selfEmails: readonly string[];
  /**
   * Whether the vault's settings have answered for the owner's name and
   * addresses. Until they have, nothing is imported: a meeting linked with
   * neither would propose its own owner as someone new.
   */
  ownerKnown: boolean;
  /** Whether this Mac may act on what sync brought in, and the pull that says so (ADR-0035 part 4). */
  pulledFiles: Pick<PulledFilesGate, 'standing' | 'acts' | 'countGate' | 'slept' | 'paused'>;
  /**
   * The name the settings keep for the Mac they name, when that is another
   * Mac than this one (compared by id); null when this Mac is named, or that
   * is not known yet.
   */
  namedElsewhere: { readonly name: string | null } | null;
  /** Told what waits for the named Mac, each time it is judged; null when nothing is to be said. */
  onWaiting: (vault: string, waiting: MeetingsWaiting | null) => void;
  /** Re-reads the tree and the index once the import has written or moved a note. */
  onWritten: () => void;
  /**
   * What the rules that write summaries have finished with, and why this
   * Mac's own step cannot reach Claude (#182): what the count adds pending
   * meetings from, and what the Mac that runs the automations says. Left
   * out, no rule writes summaries.
   */
  postProcessing?: PostProcessingNews;
}): void {
  const { standing, acts, countGate } = pulledFiles;
  // Imports only once the owner is known, as if this Mac did not import until then.
  const importing = active && ownerKnown;
  const latest = useRef({
    ports,
    onWritten,
    vaultKey,
    active: importing,
    selfName,
    selfEmails,
    acts,
    countGate,
    namedElsewhere,
    onWaiting,
    postProcessing,
  });
  latest.current = {
    ports,
    onWritten,
    vaultKey,
    active: importing,
    selfName,
    selfEmails,
    acts,
    countGate,
    namedElsewhere,
    onWaiting,
    postProcessing,
  };
  const [importer, setImporter] = useState<MeetingImporter | null>(null);

  useEffect(() => {
    const linker = createMeetingLinker({
      ports: () => latest.current.ports,
      clock,
      activity,
      openVault: () => latest.current.vaultKey,
      selfName: () => latest.current.selfName,
      selfEmails: () => latest.current.selfEmails,
      onWritten: () => latest.current.onWritten(),
    });
    const made = createMeetingImporter({
      ports: () => latest.current.ports,
      clock,
      activity,
      openVault: () => latest.current.vaultKey,
      active: (vault) => latest.current.active && latest.current.acts(vault),
      // And again for each file, as it arrived, right before each write.
      mayWrite: async (vault, _path, arrivedAt) =>
        latest.current.active && (await latest.current.acts(vault, { modifiedAt: arrivedAt })),
      onWritten: () => latest.current.onWritten(),
      // Linked before the stamp: see `createMeetingLinker`.
      beforeLetIn: async (vault, path, reading) => {
        await linker(vault, [path], reading);
      },
      waiting: {
        namedElsewhere: () => latest.current.namedElsewhere,
        countGate: (vault) => latest.current.countGate(vault),
        said: (vault, waiting) => latest.current.onWaiting(vault, waiting),
        postProcessing: () => latest.current.postProcessing.ledger(),
        rulesTake: (_vault, asked) => latest.current.postProcessing.take(asked),
        stepFailing: () => {
          const { unavailable, mac } = latest.current.postProcessing;
          return unavailable === null ? null : { problem: unavailable, mac };
        },
      },
    });
    setImporter(made);
    return importMeetingsOnArrival({ changes, importer: made });
  }, [changes, clock, activity]);

  // The index's status is the last vault's until the new vault's sync starts,
  // so a ready status counts for this vault only once it has been seen not
  // ready since the vault opened.
  const readyFor = useRef<{ vault: string | null; seenWorking: boolean }>({
    vault: null,
    seenWorking: false,
  });
  if (readyFor.current.vault !== vaultKey)
    readyFor.current = { vault: vaultKey, seenWorking: false };
  if (!indexReady) readyFor.current.seenWorking = true;
  const readyHere = indexReady && readyFor.current.seenWorking;

  // Once per pull of the vault completed while this is the importing Mac, once its index is ready.
  const caughtUp = useRef<{ vault: string; standing: PullStanding } | null>(null);
  useEffect(() => {
    if (!importing || vaultKey === null) caughtUp.current = null;
    if (importer === null || !importing || !readyHere || vaultKey === null) return;
    if (standing === null || standing.kind === 'pulling') return;
    if (caughtUp.current?.vault === vaultKey && caughtUp.current.standing === standing) return;
    caughtUp.current = { vault: vaultKey, standing };
    void importer.catchUp(vaultKey);
  }, [importer, importing, readyHere, vaultKey, standing]);

  useCountWaiting({
    importer,
    vaultKey,
    gate: pulledFiles,
    importing,
    namedElsewhere,
    onWaiting,
  });
  useRecountOnPostProcessing({
    importer,
    vaultKey,
    importing,
    namedElsewhere,
    news: postProcessing,
  });
}

/** What the rules that write summaries say, as the count reads it (#182). */
export interface PostProcessingNews {
  /** Moves whenever what they have finished with does. */
  readonly mark: string;
  /** Why this Mac's own step cannot reach Claude; null while it can, or it has not been tried. */
  readonly unavailable: string | null;
  /** The Mac's name, when it runs the automations; null otherwise or when the settings keep none. */
  readonly mac: string | null;
  /** What they have finished with, read when a count is judged. */
  readonly ledger: () => PostProcessingLedger;
  /** Which of these meetings their own queries take, asked of the index; null when it cannot say. */
  readonly take: (asked: {
    readonly paths: readonly VaultPath[];
    readonly generation: number;
  }) => Promise<PostProcessingLedger['taken'] | null>;
}

const NO_NEWS: PostProcessingNews = {
  mark: '',
  unavailable: null,
  mac: null,
  ledger: () => NO_POST_PROCESSING,
  take: async () => null,
};

/**
 * Says again what waits, importing nothing, when what the rules that write
 * summaries have finished with changes, or whether this Mac's step reaches
 * Claude (#182) — on a Mac that counts, or on the one that imports while its
 * step fails or just stopped failing. Elsewhere no line could show, so
 * nothing is asked. The vault's first news is the catch-up's to judge.
 */
function useRecountOnPostProcessing({
  importer,
  vaultKey,
  importing,
  namedElsewhere,
  news,
}: {
  importer: MeetingImporter | null;
  vaultKey: string | null;
  importing: boolean;
  namedElsewhere: { readonly name: string | null } | null;
  news: PostProcessingNews;
}): void {
  const { mark, unavailable } = news;
  const heard = useRef<{ vault: string; mark: string; unavailable: string | null } | null>(null);
  useEffect(() => {
    if (importer === null || vaultKey === null) return;
    const before = heard.current;
    heard.current = { vault: vaultKey, mark, unavailable };
    if (before === null || before.vault !== vaultKey) return;
    if (before.mark === mark && before.unavailable === unavailable) return;
    const counting = !importing && namedElsewhere !== null;
    const failingHere = importing && (unavailable !== null || before.unavailable !== null);
    if (counting || failingHere) void importer.recount(vaultKey);
  }, [importer, vaultKey, mark, unavailable, importing, namedElsewhere]);
}

/** What the count is asked again for: the pull, a sleep since it, the pause, and who is named. */
interface CountAsked {
  readonly vault: string;
  readonly standing: PullStanding | null;
  readonly slept: boolean;
  readonly paused: boolean;
  readonly name: string | null;
}

const sameAsk = (one: CountAsked | null, other: CountAsked) =>
  one !== null &&
  one.vault === other.vault &&
  one.standing === other.standing &&
  one.slept === other.slept &&
  one.paused === other.paused &&
  one.name === other.name;

/**
 * On a Mac that is not named, asks the importer what waits for the named
 * Mac as the vault opens, after each pull, and whenever the gates shut or
 * open without a pull — a sleep since it, or the pause — so a number is
 * never shown while they do not hold. A run it may not make counts instead
 * of importing. Nothing is asked while a pull is under way: what it brings is
 * judged once it completes. Once this Mac is named, or the settings stop
 * naming another, nothing waits any more.
 */
function useCountWaiting({
  importer,
  vaultKey,
  gate,
  importing,
  namedElsewhere,
  onWaiting,
}: {
  importer: MeetingImporter | null;
  vaultKey: string | null;
  gate: Pick<PulledFilesGate, 'standing' | 'slept' | 'paused'>;
  importing: boolean;
  namedElsewhere: { readonly name: string | null } | null;
  onWaiting: (vault: string, waiting: MeetingsWaiting | null) => void;
}): void {
  const counting = !importing && namedElsewhere !== null;
  const name = namedElsewhere?.name ?? null;
  const { standing, slept, paused } = gate;
  const asked = useRef<CountAsked | null>(null);
  useEffect(() => {
    if (vaultKey === null) return;
    if (!counting) {
      if (asked.current !== null) onWaiting(vaultKey, null);
      asked.current = null;
      return;
    }
    // A pause shuts the gates mid-pull too: weighed before the pull is waited for.
    if (importer === null || (standing?.kind === 'pulling' && !paused)) return;
    const now = { vault: vaultKey, standing, slept, paused, name };
    if (sameAsk(asked.current, now)) return;
    asked.current = now;
    void importer.catchUp(vaultKey);
  }, [importer, counting, vaultKey, standing, slept, paused, name, onWaiting]);
}
