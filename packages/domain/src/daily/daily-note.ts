import type { BuiltInTypeFile } from '../types/para.ts';
import type { ObjectType, PropertyDef } from '../types/property-def.ts';
import { isMarkdownName, noteTitle } from '../vault/vault-entry.ts';
import { joinVaultPath, parentVaultPath, VAULT_ROOT, type VaultPath } from '../vault/vault-path.ts';
import { foldedVaultPath } from '../vault/vault-spelling.ts';

/**
 * Today's note is a note of this type: one a day, named by its date, in the
 * type's home folder (#214). Daily notes imported from Notion carry it already.
 */
export const DAILY_TYPE = 'daily';

const property = (key: string, kind: PropertyDef['kind'], label: string): PropertyDef => ({
  key,
  kind,
  label,
  required: false,
  options: [],
  target: null,
  many: false,
});

/** The day and the tags the Notion import writes on a daily note, typed. */
const DATE = property('date', 'date', 'Date');
const TAGS = property('tags', 'multiSelect', 'Tags');

/** The Daily type, as written into a vault that lacks it once the person says yes. */
export const DAILY_TYPE_FILE: BuiltInTypeFile = {
  type: { name: DAILY_TYPE, label: 'Daily', icon: 'calendar', properties: [DATE, TAGS] },
  body: [
    '# Daily',
    '',
    "One note a day, named by its date: `2026-10-12.md`. Today's note (⇧⌘D) opens it,",
    "and makes it from the vault's Daily template when it is not there yet.",
    '',
  ].join('\n'),
};

/** A vault's type name as the disk compares its file's: in any case. */
const folded = (name: string) => name.trim().toLowerCase();

/**
 * The Daily type to offer a vault, or null when it has one already. It is
 * only ever offered, as the Inbox's own types are: a note of an undefined
 * type works, so nothing breaks while the offer waits.
 */
export function dailyTypeToOffer(existing: readonly ObjectType[]): BuiltInTypeFile | null {
  return existing.some((type) => folded(type.name) === DAILY_TYPE) ? null : DAILY_TYPE_FILE;
}

/**
 * The vault's note for `today`, if it has one: in `home`, the Daily type's
 * folder for the day, or else at the root, where today's note was made before
 * it had a home (#214) — named by the date however the disk spells it,
 * `2026-10-12.md`, `.MD`, `.markdown`, since APFS opens any of them by the
 * other's name. `<date>.md` exactly wins; without it, the first note listed
 * under another spelling is the day's. A note of that name in any other
 * folder is some other note.
 */
export function dailyNoteAmong(
  today: string,
  notePaths: readonly VaultPath[],
  home: VaultPath = VAULT_ROOT,
): VaultPath | null {
  const found = dailyNoteIn({ today, notePaths, folder: home });
  if (found !== null || home === VAULT_ROOT) return found;
  return dailyNoteIn({ today, notePaths, folder: VAULT_ROOT });
}

function dailyNoteIn({
  today,
  notePaths,
  folder,
}: {
  today: string;
  notePaths: readonly VaultPath[];
  folder: VaultPath;
}): VaultPath | null {
  const exact = joinVaultPath(folder, `${today}.md`);
  if (notePaths.includes(exact)) return exact;
  const day = foldedVaultPath(today);
  const within = foldedVaultPath(folder);
  return (
    notePaths.find(
      (path) =>
        foldedVaultPath(parentVaultPath(path)) === within &&
        isMarkdownName(path) &&
        foldedVaultPath(noteTitle(path)) === day,
    ) ?? null
  );
}
