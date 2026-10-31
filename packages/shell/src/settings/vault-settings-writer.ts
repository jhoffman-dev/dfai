import {
  createSettingsWriter,
  type MarkdownPort,
  type SettingsWriter,
  type VaultFsPort,
} from '@dfai/application';

// Keyed by the vault's file port, which the app makes once for each vault it
// opens: every setting in one vault then shares a writer, and a vault that is
// closed takes its writer with it.
const writers = new WeakMap<VaultFsPort, SettingsWriter>();

/**
 * The writer for a vault's settings note — the same one for every setting
 * kept there, so their writes queue behind each other instead of racing.
 */
export function vaultSettingsWriter({
  fs,
  markdown,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
}): SettingsWriter {
  const known = writers.get(fs);
  if (known !== undefined) return known;
  const made = createSettingsWriter({ fs, markdown });
  writers.set(fs, made);
  return made;
}
