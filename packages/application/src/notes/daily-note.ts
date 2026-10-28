import {
  DAILY_TYPE,
  dailyNoteAmong,
  dailyNoteContents,
  joinVaultPath,
  noteFileName,
  VAULT_ROOT,
  type VaultPath,
} from '@dfai/domain';
import { newNoteTaskRules } from '../gtd/task-rules.ts';
import { findDailyTemplate, readTemplate, type NoteTemplate } from '../types/templates.ts';
import { ensureFolder } from '../vault/create-folder.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { listVaultNotes } from '../vault/read-vault.ts';
import { homeFolderFor } from './home-folder.ts';
import type { MarkdownPort } from './ports.ts';

/**
 * Where today's note lives: named by the date, in `folder` — the Daily type's
 * home for the day, `Daily/2026` (#214) — which is what every other tool
 * that keeps daily notes settles on for the name.
 */
export function dailyNotePath(today: string, folder: VaultPath): VaultPath {
  return joinVaultPath(folder, noteFileName(today));
}

/**
 * Today's note, made on demand.
 *
 * Found where it should be if it is already there, however the disk spells
 * its name — a daily note imported from elsewhere included, and one made at
 * the root before daily notes had a home — otherwise created in the Daily
 * type's home folder (#214), never beside
 * whatever note happens to be in view, or the next ask would not find it. It
 * starts from the vault's Daily template when it has one, and as a note of the
 * built-in Daily type otherwise.
 *
 * Its exact name is the point, so it is not made through `createNote`, which
 * numbers a taken name; what it starts as is held to the task rules here, as
 * `createNote` holds every other new note (ADR-0029).
 */
export async function ensureDailyNote({
  fs,
  markdown,
  today,
  notePaths,
  templates,
}: {
  fs: VaultFsPort;
  /** What the starting text is judged and dated through. */
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'updateFrontmatter'>;
  /** `YYYY-MM-DD`, from the `Clock`. */
  today: string;
  notePaths: readonly VaultPath[];
  templates: readonly NoteTemplate[];
}): Promise<{ path: VaultPath; created: boolean }> {
  const home =
    (await homeFolderFor({ fs, markdown, properties: { type: DAILY_TYPE }, today })) ?? VAULT_ROOT;
  const existing = dailyNoteAmong(today, notePaths, home);
  if (existing !== null) return { path: existing, created: false };
  const path = dailyNotePath(today, await ensureFolder({ fs, folder: home }));

  const template = findDailyTemplate(templates);
  const started =
    template === null ? dailyNoteContents(today) : await readTemplate({ fs, template });
  const contents = newNoteTaskRules({ markdown, contents: started, today });
  try {
    await fs.createNote({ path, contents });
  } catch (error) {
    // Another program made it after the listing, or the disk holds it under
    // another spelling: it is found, not numbered.
    const found = dailyNoteAmong(today, await listVaultNotes({ fs }), home);
    if (found !== null) return { path: found, created: false };
    throw error;
  }
  return { path, created: true };
}
