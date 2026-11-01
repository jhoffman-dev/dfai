import { useCallback, useEffect, useRef, useState } from 'react';
import { createVaultPath, noteTitle } from '@dfai/domain';
import {
  bindSecret,
  deleteSecret,
  listSecrets,
  saveSecret,
  type IndexPort,
  type MarkdownPort,
  type SecretListing,
  type SecretStorePort,
  type VaultFsPort,
} from '@dfai/application';
import type { SecretRow, SecretSave } from '@dfai/ui';
import type { IndexNewsFeed } from '../reads/use-scoped-index-news.ts';

/** Settings → Secrets as the card draws it, and what it can ask for. */
export interface SecretsSetting {
  readonly rows: readonly SecretRow[];
  readonly problem: string | null;
  readonly pending: boolean;
  /** Resolves true once stored, false when refused (and `problem` says why). */
  readonly save: (secret: SecretSave) => Promise<boolean>;
  readonly bind: (binding: { name: string; sites: string }) => Promise<boolean>;
  readonly remove: (name: string) => void;
}

const rowsOf = (listings: readonly SecretListing[], stored: boolean): SecretRow[] =>
  listings.map(({ name, usedBy, origins }) => ({
    name,
    usedBy: usedBy.map((path) => noteTitle(createVaultPath(path))),
    stored,
    origins,
  }));

const NO_VAULT = 'Open a vault to keep secrets for it.';

/**
 * The open vault's secrets, re-read when its files change so a source that
 * starts naming one shows up under "used by" — but only while Settings is
 * open (`active`): the listing asks the Keychain, which is not free, and
 * nothing else draws it. A value passes through `save` on its way to the host
 * and is held nowhere here.
 */
export function useSecrets({
  store,
  fs,
  markdown,
  index,
  vault,
  edits,
  active,
}: {
  store: SecretStorePort;
  fs: VaultFsPort;
  markdown: MarkdownPort;
  index: IndexPort;
  /** The open vault's path, which each write names so a switch refuses it. */
  vault: string | null;
  /**
   * The index's news of any note (`SECRETS_SCOPE`): any note can be a source
   * that names a secret. Heard only while Settings is open (#326).
   */
  edits: IndexNewsFeed;
  /** True while Settings is open. */
  active: boolean;
}): SecretsSetting {
  const [rows, setRows] = useState<readonly SecretRow[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reads, setReads] = useState(0);
  // Reads can land out of order after a write; only the latest may land.
  const latest = useRef(0);

  useEffect(() => {
    latest.current += 1;
    const ticket = latest.current;
    if (vault === null) {
      setRows([]);
      return;
    }
    if (!active) return;
    listSecrets({ store, fs, markdown, index })
      .then(({ stored, unset }) => {
        if (ticket === latest.current) setRows([...rowsOf(stored, true), ...rowsOf(unset, false)]);
      })
      .catch((cause: unknown) => {
        if (ticket === latest.current) {
          setProblem(cause instanceof Error ? cause.message : String(cause));
        }
      });
  }, [store, fs, markdown, index, vault, reads, active]);
  useEffect(
    () => (active ? edits.subscribe(() => setReads((count) => count + 1)) : undefined),
    [edits, active],
  );

  const run = useCallback(async (action: () => Promise<string | null>): Promise<boolean> => {
    setPending(true);
    setProblem(null);
    const refused = await action();
    setPending(false);
    setProblem(refused);
    setReads((count) => count + 1);
    return refused === null;
  }, []);

  const inVault = (action: (vault: string) => Promise<string | null>) =>
    run(() => (vault === null ? Promise.resolve(NO_VAULT) : action(vault)));

  return {
    rows,
    problem,
    pending,
    save: (secret) => inVault((at) => saveSecret({ store, ...secret, vault: at })),
    bind: ({ name, sites }) => inVault((at) => bindSecret({ store, name, sites, vault: at })),
    remove: (name) => void inVault((at) => deleteSecret({ store, name, vault: at })),
  };
}
