import {
  ATLAS_DIRECTORY,
  createVaultPath,
  opensUnclosedFrontmatter,
  splitFrontmatter,
  VAULT_ROOT,
  VAULT_SETTINGS_PATH,
  type VaultPath,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import { writeFrontmatterChanges } from '../query/set-property.ts';
import type { VaultFsPort } from '../vault/ports.ts';

const SETTINGS = createVaultPath(VAULT_SETTINGS_PATH);

/**
 * The vault's own settings, read out of `.atlas/settings.md` — a note like any
 * other, so they travel with the vault and can be edited anywhere. A vault
 * without the file has said nothing, which is not an error; a file whose
 * frontmatter cannot be read is, since reading it as empty would quietly put
 * every setting in it back to its default.
 */
export async function readVaultSettings({
  fs,
  markdown,
  path = SETTINGS,
  required = false,
}: {
  fs: Pick<VaultFsPort, 'readNotes'>;
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>;
  /** Another copy of the settings note to read — one a sync conflict saved aside. */
  path?: VaultPath;
  /**
   * Whether the file must be there, as in a vault that syncs, whose settings
   * name the Mac that runs its automations: then a missing one is refused as
   * unreadable rather than read as saying nothing (ADR-0035).
   */
  required?: boolean;
}): Promise<Readonly<Record<string, unknown>>> {
  // `readNotes` leaves out a file that is not there, or cannot be read as text, where a read would throw.
  const [file] = await fs.readNotes([path]);
  if (file === undefined && required) {
    throw new Error(`${VAULT_SETTINGS_PATH} is not there, or cannot be read as text.`);
  }
  if (file === undefined) return {};
  return settingsOfText(markdown, file.text);
}

/**
 * What a settings note's text says; refused as unreadable when its frontmatter
 * does not parse, or opens and never closes — read as none, every setting would
 * quietly be its default (#683).
 */
export function settingsOfText(
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>,
  text: string,
): Readonly<Record<string, unknown>> {
  if (opensUnclosedFrontmatter(text)) {
    throw new UnreadableSettingsError(
      `${VAULT_SETTINGS_PATH} can't be read, so its settings are left as they are until it is fixed: its frontmatter has no closing ---`,
    );
  }
  const { frontmatter } = splitFrontmatter(text);
  refuseUnreadable(markdown, frontmatter);
  return markdown.frontmatterProperties(frontmatter);
}

/**
 * Writes settings into the vault's settings note.
 *
 * Into the file as it stands, through the byte-preserving frontmatter write,
 * so every other setting and any words in it are left as they were. A vault
 * without the file gets one, and without `.atlas`, that as well. A file whose
 * frontmatter cannot be read is left alone: whatever it was meant to say, a
 * write could only lose it.
 */
export async function saveVaultSettings({
  fs,
  markdown,
  changes,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  changes: Readonly<Record<string, unknown>>;
}): Promise<void> {
  const [file] = await fs.readNotes([SETTINGS]);
  if (file !== undefined) {
    refuseUnreadable(markdown, splitFrontmatter(file.text).frontmatter);
    await writeFrontmatterChanges({ fs, markdown, path: SETTINGS, values: changes });
    return;
  }
  await ensureAtlasFolder(fs);
  const frontmatter = markdown.updateFrontmatter(null, changes);
  await fs.createNote({ path: SETTINGS, contents: `${frontmatter}\n# Settings\n` });
}

/** The vault's settings note is there and its frontmatter cannot be read. */
export class UnreadableSettingsError extends Error {}

function refuseUnreadable(
  markdown: Pick<MarkdownPort, 'frontmatterProblem'>,
  frontmatter: string | null,
): void {
  const problem = markdown.frontmatterProblem(frontmatter);
  if (problem !== null)
    throw new UnreadableSettingsError(
      `${VAULT_SETTINGS_PATH} can't be read, so its settings are left as they are until it is fixed: ${problem}`,
    );
}

async function ensureAtlasFolder(fs: VaultFsPort): Promise<void> {
  const root = await fs.listDirectory(VAULT_ROOT);
  if (root.some((entry) => entry.kind === 'directory' && entry.name === ATLAS_DIRECTORY)) return;
  await fs.createFolder({ path: createVaultPath(ATLAS_DIRECTORY) });
}
