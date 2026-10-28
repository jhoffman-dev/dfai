import {
  createVaultPath,
  extrasDfaiWrote,
  keysRecorded,
  liveExtras,
  parseShippedPropertiesRecord,
  recordExtrasShipped,
  settingsFileOfCopy,
  SHIPPED_PROPERTIES,
  SHIPPED_PROPERTIES_RECORD_PATH,
  splitFrontmatter,
  type ShippedPropertiesRecord,
} from '@dfai/domain';
import type { ActivityRecorder } from '../activity/ports.ts';
import type { UnsettledSaid } from '../meetings/index.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { EntryChangedError, type NoteContents, type VaultFsPort } from '../vault/ports.ts';
import { readIndex } from './git-steps.ts';
import { mergeSettings } from './merge-settings.ts';
import type { GitPort } from './ports.ts';

/** What clearing the copies needs: the tracked paths, the vault's files and the Trash, frontmatter, and Activity. */
export interface ClearCopiesPorts {
  readonly git: Pick<GitPort, 'indexEntries'>;
  readonly fs: Pick<VaultFsPort, 'readTextFile' | 'trashEntry'>;
  readonly markdown: MarkdownPort;
  readonly activity: ActivityRecorder;
}

const RECORD_PATH = SHIPPED_PROPERTIES_RECORD_PATH as string;
const TYPES_FOLDER = '.atlas/types/';

/**
 * Moves to the Trash each conflict copy of one of DFAI's own files, under
 * `Sync conflicts/atlas/`, that holds nothing its live file lacks and lacks
 * nothing but what DFAI wrote into the live file itself (#235, ADR-0048):
 *
 * - the live file merged with the copy by its keys, as sync merges the two
 *   Macs' versions, with no base, comes back byte for byte as it is;
 * - every key the live file has beyond the copy is a property the vault's
 *   record says DFAI added to that type — or, for the record itself, a key
 *   DFAI ships on that type. Anything else may be a person's deletion on the
 *   copy's Mac, which the copy is the only sign of.
 *
 * The host trashes a copy only while it and its live file are still as read
 * here; a copy that cannot be read, nor its live file, stays. So does one in
 * `keep` — made by this sync, and about to be reported. Says each copy
 * cleared in Activity, and each kept for a change or a refusing Trash once
 * in `said`'s session, again when it changes; gives the cleared back.
 */
export async function clearSettledCopies({
  ports,
  keep,
  said,
}: {
  ports: ClearCopiesPorts;
  keep: ReadonlySet<string>;
  /** What was said of copies kept; left out, each is said every time. */
  said?: UnsettledSaid;
}): Promise<readonly string[]> {
  const cleared: string[] = [];
  const added = lazyAdded(ports.fs);
  for (const { path: copy, stage } of await readIndex(ports.git)) {
    const live = settingsFileOfCopy(copy);
    if (stage !== 0 || live === null || keep.has(copy)) continue;
    const read = await addsNothing(ports, { copy, live, added });
    if (read === null) continue;
    if (await trash({ ports, said }, { copy, live, read })) cleared.push(copy);
  }
  return cleared;
}

interface CopyOf {
  readonly copy: string;
  readonly live: string;
}

interface BothRead {
  readonly copy: NoteContents;
  readonly live: NoteContents;
}

/** The keys DFAI added to each type, from the vault's record, read once; none when it cannot be read. */
function lazyAdded(fs: ClearCopiesPorts['fs']): () => Promise<ShippedPropertiesRecord['added']> {
  let added: Promise<ShippedPropertiesRecord['added']> | null = null;
  return () => {
    added ??= fs
      .readTextFile(SHIPPED_PROPERTIES_RECORD_PATH)
      .then(({ text }) => parseShippedPropertiesRecord(text).added)
      .catch(() => {
        // Safe to ignore: with no record to read, no key counts as DFAI's, so only a copy
        // that lacks nothing at all can go.
        return {};
      });
    return added;
  };
}

/** Both files as read, when the copy can go by what they hold (see above); null to keep it. */
async function addsNothing(
  { fs, markdown }: ClearCopiesPorts,
  { copy, live, added }: CopyOf & { added: () => Promise<ShippedPropertiesRecord['added']> },
): Promise<BothRead | null> {
  const read = await readBoth(fs, { copy, live });
  if (read === null) return null;
  const merged = mergeSettings(markdown, {
    path: live,
    base: null,
    ours: read.live.text,
    theirs: read.copy.text,
  });
  if (merged !== read.live.text) return null;
  const onlyDfais =
    live === RECORD_PATH
      ? recordExtrasShipped({
          live: parseShippedPropertiesRecord(read.live.text),
          copy: parseShippedPropertiesRecord(read.copy.text),
          shipped: SHIPPED_PROPERTIES,
        })
      : typeExtrasDfaiWrote(markdown, { live, read, added: await added() });
  if (!onlyDfais) return null;
  // Read again: a write to either since is seen here, before the host is asked at all.
  const again = await readBoth(fs, { copy, live });
  return again !== null && same(read.copy, again.copy) && same(read.live, again.live)
    ? again
    : null;
}

function typeExtrasDfaiWrote(
  markdown: MarkdownPort,
  { live, read, added }: { live: string; read: BothRead; added: ShippedPropertiesRecord['added'] },
): boolean {
  const values = (text: string) =>
    markdown.frontmatterProperties(splitFrontmatter(text).frontmatter);
  const own = values(read.live.text);
  const name = own['name'];
  const wrote =
    live.startsWith(TYPES_FOLDER) && typeof name === 'string' ? keysRecorded(added, name) : [];
  return extrasDfaiWrote({
    extras: liveExtras({ live: own, copy: values(read.copy.text) }),
    added: wrote,
  });
}

const same = (first: NoteContents, second: NoteContents) =>
  first.text === second.text && first.modified === second.modified;

async function readBoth(
  fs: ClearCopiesPorts['fs'],
  { copy, live }: CopyOf,
): Promise<BothRead | null> {
  try {
    const [copyRead, liveRead] = await Promise.all([
      fs.readTextFile(createVaultPath(copy)),
      fs.readTextFile(createVaultPath(live)),
    ]);
    return { copy: copyRead, live: liveRead };
  } catch {
    // Safe to ignore: a file that cannot be read whole — missing, refused, not
    // text — cannot be shown to hold nothing more, so the copy stays for a person.
    return null;
  }
}

/**
 * Asks the host to trash the copy while it and its live file are as read, and
 * says what came of it. A copy kept — changed since, or a Trash that refuses —
 * is said once in `said`'s session, and again only when it or the outcome changes.
 */
async function trash(
  { ports: { fs, activity }, said }: { ports: ClearCopiesPorts; said: UnsettledSaid | undefined },
  { copy, live, read }: CopyOf & { read: BothRead },
): Promise<boolean> {
  try {
    await fs.trashEntry({
      path: createVaultPath(copy),
      unchanged: [
        { path: createVaultPath(copy), modified: read.copy.modified, text: read.copy.text },
        { path: createVaultPath(live), modified: read.live.modified, text: read.live.text },
      ],
    });
  } catch (cause) {
    const changed = cause instanceof EntryChangedError;
    const message = changed
      ? `The conflict copy ${copy} was kept: it or ${live} changed while it was checked.`
      : `The conflict copy ${copy} holds nothing ${live} lacks, but it could not be moved to the Trash: ${cause instanceof Error ? cause.message : String(cause)}`;
    if (said?.isNews(copy, `${read.copy.modified}\n${read.copy.text}\n${message}`) ?? true) {
      activity.record({
        level: changed ? 'info' : 'warning',
        kind: 'sync',
        message,
        subject: null,
      });
    }
    return false;
  }
  activity.record({
    level: 'info',
    kind: 'sync',
    message: `Cleared the conflict copy ${copy}: ${live} already holds everything in it. It is in the Trash.`,
    subject: null,
  });
  return true;
}
