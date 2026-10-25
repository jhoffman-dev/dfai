import type { VaultPath } from '../vault/vault-path.ts';

/** One change accepting a proposal makes to the vault. */
export type ProposalWrite =
  | {
      readonly kind: 'create';
      readonly path: VaultPath;
      readonly properties: Readonly<Record<string, unknown>>;
      readonly body: string;
    }
  | {
      readonly kind: 'set';
      readonly path: VaultPath;
      readonly changes: Readonly<Record<string, unknown>>;
    };

export type ProposalApplication =
  | { readonly ok: true; readonly writes: readonly ProposalWrite[] }
  | { readonly ok: false; readonly problem: string };
