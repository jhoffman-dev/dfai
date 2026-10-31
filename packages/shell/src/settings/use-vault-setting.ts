import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityLog, MarkdownPort, VaultFsPort } from '@dfai/application';
import { withGiveUpRecorded } from '../activity/with-give-up-recorded.ts';
import { useVaultSettingsRead } from './use-vault-settings-read.ts';

/** One setting kept in the vault's settings note: what it holds, and a way to change it. */
export interface VaultSetting<Value> {
  /** What this vault's settings hold; null when they say nothing, before they are read, or when they cannot be. */
  readonly value: Value | null;
  /** Whether `value` is what this vault's settings hold, rather than a stand-in until they are read. */
  readonly loaded: boolean;
  /**
   * Whether this vault's settings note has been read, whatever it answered:
   * `loaded`, or found `unreadable`. Until then nothing about the setting is known.
   */
  readonly answered: boolean;
  /** Shows `value` at once and writes it behind it. */
  readonly save: (value: Value) => void;
  /** As `save`, for a caller that waits on the write: settles once it has, with why it failed or null. */
  readonly write: (value: Value) => Promise<string | null>;
  /** Reads the settings note again, for a write made past this setting's own (the automations claim). */
  readonly readAgain: () => Promise<void>;
  /** Why the last save failed. */
  readonly problem: string | null;
  /** Why the settings note cannot be read; while it cannot, nothing is written to it. */
  readonly unreadable: string | null;
}

/** Something said of one vault, so it is never handed out for another. */
interface Said<T> {
  readonly vault: string;
  readonly value: T;
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * A setting read from the vault's settings note — the window's one read of
 * it (`useVaultSettingsRead`), made again when the note changes, so an edit
 * made in another editor shows up. A change shows at once and is written
 * behind it; it stays shown until its write has landed, and a read that
 * comes back in the meantime is set aside rather than shown, since it may
 * predate the write. Once the writes have landed the note is read again,
 * which puts back what the file holds if one of them failed. A failed write
 * is shown by the setting and recorded in the Activity log.
 */
export function useVaultSetting<Value>({
  fs,
  markdown,
  parse,
  store,
  vaultKey,
  activity,
}: {
  fs: Pick<VaultFsPort, 'readNotes'>;
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>;
  /** The setting in the settings read; a new function means it is taken out of them again. */
  parse: (settings: Readonly<Record<string, unknown>>) => Value | null;
  /**
   * Writes the setting, through the vault's one settings writer. `previous` is
   * what this vault's settings were last read or saved as — null before the
   * first read — so a store can write only what changed.
   */
  store: (value: Value, previous: Value | null) => Promise<void>;
  vaultKey: string | null;
  activity: Pick<ActivityLog, 'inOpenVault'>;
}): VaultSetting<Value> {
  const read = useVaultSettingsRead({ fs, markdown, vaultKey });
  // Held with the vault it belongs to, so another vault's value is never handed out.
  const [held, setHeld] = useState<Said<Value | null> | null>(null);
  const value = held?.vault === vaultKey ? held.value : null;
  // The vault whose settings `value` was read from.
  const [loadedFrom, setLoadedFrom] = useState<string | null>(null);
  // The vault whose settings note last answered a read, whether or not it could be read.
  const [answeredFor, setAnsweredFor] = useState<string | null>(null);
  // Each said of the vault it is about, so a switch does not carry them into the next.
  const [problem, setProblem] = useState<Said<string> | null>(null);
  const [unreadable, setUnreadable] = useState<Said<string> | null>(null);
  // The writes under way, by the vault they write to: only that vault's reads are set aside.
  const writing = useRef(new Map<string, number>());
  // Once a vault's writes land, the read they wait for: the vault's next after this answer.
  const waitingPast = useRef<{ vault: string; answer: object | null } | null>(null);

  const { settings, unreadable: failure, answer } = read;
  useEffect(() => {
    if (vaultKey === null) {
      setHeld(null);
      setLoadedFrom(null);
      setAnsweredFor(null);
      return;
    }
    if ((writing.current.get(vaultKey) ?? 0) > 0) return;
    const waiting = waitingPast.current;
    if (waiting?.vault === vaultKey && answer === waiting.answer) return;
    waitingPast.current = null;
    if (failure !== null) {
      setUnreadable({ vault: vaultKey, value: failure });
      setLoadedFrom(null);
      setAnsweredFor(vaultKey);
      return;
    }
    if (settings === undefined) return;
    setHeld({ vault: vaultKey, value: parse(settings) });
    setUnreadable(null);
    setLoadedFrom(vaultKey);
    setAnsweredFor(vaultKey);
  }, [settings, failure, answer, parse, vaultKey]);

  const { readAgain, latestAnswer } = read;
  const write = useCallback(
    (next: Value): Promise<string | null> => {
      // No vault open: there is no note to write to, and nothing shows a setting.
      if (vaultKey === null) return Promise.resolve(null);
      const vault = vaultKey;
      writing.current.set(vault, (writing.current.get(vault) ?? 0) + 1);
      setHeld({ vault, value: next });
      setProblem(null);
      return withGiveUpRecorded({ activity, write: 'setting', path: null }, () =>
        store(next, value),
      )
        .then(
          () => null,
          (cause: unknown) => {
            const why = messageOf(cause);
            setProblem({ vault, value: why });
            return why;
          },
        )
        .finally(() => {
          const left = (writing.current.get(vault) ?? 1) - 1;
          if (left > 0) {
            writing.current.set(vault, left);
            return;
          }
          writing.current.delete(vault);
          // The newest answer in the cache, not this render's: one read just before
          // the write landed may not have been drawn yet, and predates the write.
          waitingPast.current = { vault, answer: latestAnswer() };
          // Every read is a new answer (no structural sharing), so the one after
          // this read runs the effect again; another vault's reads were never held.
          void readAgain();
        });
    },
    [store, vaultKey, value, activity, readAgain, latestAnswer],
  );
  const save = useCallback((next: Value) => void write(next), [write]);

  return {
    value,
    loaded: vaultKey !== null && loadedFrom === vaultKey,
    answered: vaultKey !== null && answeredFor === vaultKey,
    save,
    write,
    readAgain,
    problem: problem?.vault === vaultKey ? problem.value : null,
    unreadable: unreadable?.vault === vaultKey ? unreadable.value : null,
  };
}
