import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { shippedPropertiesLine, shippedPropertiesSkippedLine, typeSetupLines } from '@dfai/domain';
import {
  acceptTypeSetup,
  ensureBuiltInTypes,
  type ActivityRecorder,
  type MarkdownPort,
  type ShippedPropertiesAdded,
  type TypeSetupFailure,
  type TypeSetupOffer,
  type VaultFsPort,
} from '@dfai/application';

const NOTHING_OFFERED: TypeSetupOffer = { types: [], extensions: [] };

/** The offer to set the vault's types up for PARA: types to add, and what its own would gain. */
export interface TypesOffer {
  /**
   * The vault's types are still being read, so whether anything is offered is
   * not known yet: the Inbox holds its rows back for it, as for its other
   * offers (#381, #130). No lines while it is.
   */
  readonly reading: boolean;
  /** One line per change, saying what it does. */
  readonly lines: readonly string[];
  readonly accept: () => Promise<void>;
  readonly dismiss: () => void;
}

/**
 * Makes the vault's types whole when it opens: each built-in type file gains
 * the properties DFAI ships that it predates (#162), and anything else —
 * PARA for a vault without it, PARA's change to the vault's own types, its
 * Project type's PARA and Area (#213) — is held as an offer, which the Inbox
 * shows (P30-01). Null once the types are read and nothing is offered.
 */
export function useBuiltInTypes({
  fs,
  markdown,
  vaultKey,
  activity,
  onChanged,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  vaultKey: string | null;
  activity: ActivityRecorder;
  /** After a type file is written, so the types and the tree are read again. */
  onChanged: () => void;
}): TypesOffer | null {
  const [offer, setOffer] = useState<TypeSetupOffer>(NOTHING_OFFERED);
  // The vault whose types were last read, offer or not: until it is this one, they are being read.
  const [readFor, setReadFor] = useState<string | null>(null);
  // Read when a write lands, not a reason to set the vault up again.
  const changed = useRef(onChanged);
  useEffect(() => {
    changed.current = onChanged;
  }, [onChanged]);

  const report = useCallback(
    (failed: readonly TypeSetupFailure[]) => {
      for (const { name, reason } of failed) {
        activity.record({
          level: 'warning',
          kind: 'app',
          message: `The ${name} type could not be set up for PARA: ${reason}`,
          subject: null,
        });
      }
    },
    [activity],
  );

  // Nothing silent either: each type that gained properties it predates (#162).
  const announceProperties = useCallback(
    ({ gained, skipped, failed }: ShippedPropertiesAdded) => {
      for (const { path, label, added } of gained) {
        activity.record({
          level: 'info',
          kind: 'app',
          message: shippedPropertiesLine({ label, added }),
          subject: { kind: 'note', path },
        });
      }
      for (const { path, label, reason } of skipped) {
        activity.record({
          level: 'warning',
          kind: 'app',
          message: shippedPropertiesSkippedLine({ label, reason }),
          subject: { kind: 'note', path },
        });
      }
      for (const { name, reason } of failed) {
        activity.record({
          level: 'warning',
          kind: 'app',
          message: `DFAI could not add its built-in properties to ${name}: ${reason}`,
          subject: null,
        });
      }
    },
    [activity],
  );

  useEffect(() => {
    setOffer(NOTHING_OFFERED);
    setReadFor(null);
    if (vaultKey === null) return;
    let cancelled = false;
    ensureBuiltInTypes({ fs, markdown, vault: vaultKey })
      .then((ensured) => {
        if (cancelled) return;
        announceProperties(ensured.properties);
        setOffer(ensured.offer);
        setReadFor(vaultKey);
        if (ensured.properties.gained.length > 0) changed.current();
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        report([{ name: 'PARA', reason: String(cause) }]);
        setReadFor(vaultKey);
      });
    return () => {
      cancelled = true;
    };
  }, [fs, markdown, vaultKey, report, announceProperties]);

  const accept = useCallback(async () => {
    const done = await acceptTypeSetup({ fs, markdown, offer });
    report(done.failed);
    setOffer(NOTHING_OFFERED);
    if (done.created.length + done.extended.length > 0) changed.current();
  }, [fs, markdown, offer, report]);

  const dismiss = useCallback(() => setOffer(NOTHING_OFFERED), []);

  const reading = vaultKey !== null && readFor !== vaultKey;
  // One object while nothing about it changes, so what the Inbox is handed is not new on every render.
  return useMemo(() => {
    const lines = typeSetupLines(offer);
    return lines.length === 0 && !reading ? null : { reading, lines, accept, dismiss };
  }, [reading, offer, accept, dismiss]);
}
