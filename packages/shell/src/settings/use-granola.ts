import { useCallback, useMemo, useRef, useState } from 'react';
import {
  granolaCountsLine,
  granolaFailureWords,
  parseGranolaSettings,
  type GranolaSettings,
} from '@dfai/domain';
import {
  GranolaError,
  type ExternalLinkPort,
  type GranolaPort,
  type GranolaPullReport,
  type MarkdownPort,
  type VaultFsPort,
} from '@dfai/application';
import type { GranolaKeyState, GranolaNoteLine, GranolaView } from '@dfai/ui';
import type { GranolaPullController } from '../granola/use-granola-pull.ts';
import { errorMessage } from '../query/error-message.ts';
import { clockTime } from '../sync/sync-view.ts';
import { useVaultSettingsRead } from './use-vault-settings-read.ts';

/** Settings → Granola as the card draws it, and what it can ask for. */
export interface GranolaSettingState {
  readonly view: GranolaView;
  /** Hands the key to the host, which keeps it and has Granola check it; it is held nowhere here. */
  readonly saveKey: (key: string) => void;
  readonly forgetKey: () => void;
  readonly syncNow: () => void;
  readonly openNote: (url: string) => void;
}

/** Something said about one vault, kept with the vault it was said of. */
interface Said<T> {
  readonly vault: string;
  readonly value: T;
}

const problemOf = (cause: unknown) =>
  cause instanceof GranolaError ? granolaFailureWords(cause.failure) : errorMessage(cause);

function keyStateOf(pull: GranolaPullController, accepted: boolean): GranolaKeyState {
  const { key } = pull;
  if (key === null) return pull.keyProblem === null ? 'checking' : 'none';
  if (!key.hasKey) return 'none';
  if (key.lastRefusal === 401) return 'refused';
  return accepted ? 'accepted' : 'set';
}

/** The meetings a pull did not write, each once, in the order it met them. */
function notesOf(report: GranolaPullReport): GranolaNoteLine[] {
  return [...report.refused, ...report.skipped, ...report.failed].map(
    ({ id, title, url, problem }) => ({ id, title: title ?? id, url, problem }),
  );
}

/** What the last pull did, for a pull that looked at every note; else null. */
function lastPullOf(report: GranolaPullReport | null): string | null {
  if (report?.ended !== 'pulled') return null;
  return granolaCountsLine({
    written: report.written.length,
    held: report.held,
    refused: report.refused.length,
    skipped: report.skipped.length,
    failed: report.failed.length,
  });
}

/** Why the last pull stopped or failed, in the person's words. */
function pullProblemOf(report: GranolaPullReport | null): string | null {
  return report?.ended === 'stopped' || report?.ended === 'failed' ? report.problem : null;
}

/** What the vault's settings say of Granola that the card shows: why some could not be read. */
interface SettingsRead {
  /**
   * Why the owner's or the group addresses could not be read: they are then
   * read as none, and a pull writes its meetings by none (#157).
   */
  readonly addressesUnreadable: string | null;
  /** Why the settings note itself could not be read. */
  readonly problem: string | null;
}

const NOTHING_UNREADABLE: SettingsRead = { addressesUnreadable: null, problem: null };

/** Why the addresses Granola maps by could not be read, in the card's words; null when they were. */
function addressesUnreadableOf({
  selfEmailsProblem,
  groupAddressesProblem,
}: GranolaSettings): string | null {
  const unreadable = [
    selfEmailsProblem === null
      ? null
      : `Your emails in settings could not be read: ${selfEmailsProblem}`,
    groupAddressesProblem === null
      ? null
      : `The group addresses in settings could not be read: ${groupAddressesProblem}`,
  ].filter((each) => each !== null);
  return unreadable.length === 0 ? null : unreadable.join(' ');
}

/** The vault's Granola settings, from the window's one read of its settings note, for what the card says of them. */
function useSettingsRead({
  fs,
  markdown,
  vault,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  vault: string | null;
}): SettingsRead {
  const { settings, unreadable } = useVaultSettingsRead({ fs, markdown, vaultKey: vault });
  return useMemo(() => {
    if (unreadable !== null) return { addressesUnreadable: null, problem: unreadable };
    if (settings === undefined) return NOTHING_UNREADABLE;
    return {
      addressesUnreadable: addressesUnreadableOf(parseGranolaSettings(settings)),
      problem: null,
    };
  }, [settings, unreadable]);
}

/**
 * Settings → Granola: the key, which passes through `saveKey` to the host and
 * is never kept in React state, and the pull's state from the window's one
 * puller. "Key accepted" is said only of a key
 * Granola has just checked.
 */
export function useGranola({
  port,
  pull,
  vault,
  links,
  ...settings
}: {
  port: GranolaPort;
  pull: GranolaPullController;
  /** The open vault's path, which each call names so a switch refuses it. */
  vault: string | null;
  links: ExternalLinkPort;
  fs: VaultFsPort;
  markdown: MarkdownPort;
}): GranolaSettingState {
  const read = useSettingsRead({ ...settings, vault });
  const [pending, setPending] = useState(false);
  const [accepted, setAccepted] = useState<string | null>(null);
  const [problem, setProblem] = useState<Said<string> | null>(null);
  const { knowKey } = pull;

  // Set before the render that disables the buttons, so a second press in between is refused too.
  const changing = useRef(false);
  const change = useCallback(
    (at: string, ask: () => Promise<{ hasKey: boolean; lastRefusal: 401 | null }>) => {
      // The host does not order a forget after a save under way, which can take seconds
      // while Granola checks the key: one change of key at a time.
      if (changing.current) return;
      changing.current = true;
      setPending(true);
      setProblem(null);
      ask()
        .then((status) => {
          knowKey(status);
          setAccepted(status.hasKey && status.lastRefusal === null ? at : null);
        })
        .catch((cause: unknown) => setProblem({ vault: at, value: problemOf(cause) }))
        .finally(() => {
          changing.current = false;
          setPending(false);
        });
    },
    [knowKey],
  );

  const report = pull.report;
  const said = problem?.vault === vault ? problem.value : null;
  return {
    view: {
      keyState: keyStateOf(pull, vault !== null && accepted === vault),
      waiting: !pull.ready,
      pulling: pull.pulling,
      lastPull: lastPullOf(report),
      lastPullAt: pull.lastPullAt === null ? null : clockTime(pull.lastPullAt),
      notes: report === null ? [] : notesOf(report),
      addressesUnreadable: read.addressesUnreadable,
      problem: said ?? pull.keyProblem ?? read.problem ?? pullProblemOf(report),
      pending,
    },
    saveKey: (key) => {
      if (vault !== null) change(vault, () => port.setKey({ vault, key }));
    },
    forgetKey: () => {
      if (vault !== null) change(vault, () => port.forgetKey({ vault }));
    },
    syncNow: pull.syncNow,
    openNote: (url) => {
      links.open(url).catch((cause: unknown) => {
        if (vault !== null) setProblem({ vault, value: errorMessage(cause) });
      });
    },
  };
}
