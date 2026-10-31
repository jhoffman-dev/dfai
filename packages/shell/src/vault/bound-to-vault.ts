import {
  inVault,
  noVaultOpen,
  recordingOwnWrites,
  type HostVaultFsPort,
  type OwnWrites,
  type VaultFsPort,
} from '@dfai/application';

/** Ports as the composition root hands them over: the host's, not yet bound to a vault. */
export type OnHost<Ports extends { fs: VaultFsPort }> = Omit<Ports, 'fs'> & {
  readonly fs: HostVaultFsPort;
};

/**
 * The same ports, writing only into `vault`: a write that finishes after another
 * vault is opened is refused by the host rather than landing in the other
 * vault's note of the same name (R14-01). With no vault open there is nothing to
 * bind to, and every write is refused (R14-04). Given `ownWrites`, every write
 * is kept there, so the watcher's report of it is known as the app's own (#254).
 */
export function boundToVault<Ports extends { fs: HostVaultFsPort }>(
  ports: Ports,
  vault: string | null,
  ownWrites?: OwnWrites,
): Omit<Ports, 'fs'> & { fs: VaultFsPort } {
  if (vault === null) return { ...ports, fs: noVaultOpen(ports.fs) };
  const bound = inVault({ fs: ports.fs, vault });
  const fs = ownWrites === undefined ? bound : recordingOwnWrites({ fs: bound, ownWrites, vault });
  return { ...ports, fs };
}
