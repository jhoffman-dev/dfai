import { useEffect, useRef } from 'react';
import { blockTypeToWrite, messageWithoutPaths, type ObjectType } from '@dfai/domain';
import {
  ensureBlockType,
  type ActivityRecorder,
  type MarkdownPort,
  type VaultFsPort,
} from '@dfai/application';

/** The writes this hook started for one vault, and what came of them. */
interface Attempts {
  readonly vault: string;
  /** Writes started and not yet settled. */
  running: number;
  /** A write landed: Activity has said so, once. */
  added: boolean;
  /** Every write settled: the vault is not tried again until it is opened again. */
  settled: boolean;
  /** Why a write did not land, kept until every write has settled. */
  failure: string | null;
}

const ADDED = 'Added the Block type: this vault’s tasks follow GTD, and timeblocks schedule them.';

/**
 * Writes the Block type into a vault whose tasks follow GTD and that lacks it
 * (P31-01) — as it opens, or as soon as its tasks move to GTD — and says so in
 * Activity: nothing is added without a word.
 *
 * The types are read again on every change to the index, and a read can come
 * back while a write is still on its way. So a write is never cancelled: what
 * it did is said whatever has rendered since, `Added` once, and a write that
 * finds the file there because another of this hook's writes put it there is
 * no failure. Once every write for the vault has settled, it is not tried
 * again until the vault is opened again, so a file the host will not write
 * over is warned about once.
 */
export function useBlockType({
  fs,
  markdown,
  vaultKey,
  types,
  activity,
  onChanged,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  vaultKey: string | null;
  /** The vault's types as last read: the type files are read again only when they call for it. */
  types: readonly ObjectType[];
  activity: ActivityRecorder;
  /** After the type file is written, so the types and the tree are read again. */
  onChanged: () => void;
}): void {
  // Read when the write lands, not a reason to look at the vault's types again.
  const changed = useRef(onChanged);
  useEffect(() => {
    changed.current = onChanged;
  }, [onChanged]);
  const attempts = useRef<Attempts | null>(null);

  useEffect(() => {
    // Kept per vault, the one in view, whether or not it needs the type.
    if (attempts.current?.vault !== vaultKey) attempts.current = attemptsFor(vaultKey);
    const current = attempts.current;
    if (current === null || current.settled || blockTypeToWrite(types) === null) return;
    // Said only while the vault is still the one open; its writes landed either way.
    const inView = () => attempts.current === current;
    current.running += 1;
    void ensureBlockType({ fs, markdown })
      .then(({ created, failed }) => {
        if (created.length > 0 && inView()) {
          current.added = true;
          for (const path of created) {
            activity.record({
              level: 'info',
              kind: 'app',
              message: ADDED,
              subject: { kind: 'note', path },
            });
          }
          changed.current();
        }
        current.failure ??= failed[0]?.reason ?? null;
      })
      .catch((cause: unknown) => {
        current.failure ??= messageWithoutPaths(cause);
      })
      .finally(() => {
        current.running -= 1;
        if (current.running > 0) return;
        current.settled = true;
        if (!current.added && current.failure !== null && inView()) warn(activity, current.failure);
      });
  }, [fs, markdown, vaultKey, types, activity]);
}

/** No attempts yet, for the vault now in view; none with no vault open. */
function attemptsFor(vault: string | null): Attempts | null {
  return vault === null ? null : { vault, running: 0, added: false, settled: false, failure: null };
}

function warn(activity: ActivityRecorder, reason: string): void {
  activity.record({
    level: 'warning',
    kind: 'app',
    message: `The Block type could not be added: ${reason}`,
    subject: null,
  });
}
