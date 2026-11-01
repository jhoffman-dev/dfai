import {
  createVaultPath,
  createWikiLinkResolver,
  DASHBOARDS_DIRECTORY,
  TEMPLATES_DIRECTORY,
  VIEWS_DIRECTORY,
  imagePathsToRebase,
  isUserSpaceNote,
  mergeVersion,
  joinFrontmatter,
  mergedBody,
  notesAfterMerge,
  noteTitle,
  personMergeRefusal,
  planPersonMerge,
  rebaseImageSources,
  retargetMergedLinks,
  splitFrontmatter,
  type MergeNote,
  type NotesAcrossMove,
  type PersonMergePlan,
  type VaultPath,
} from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';
import { forgetNotes, notesLinkingTo } from '../index/refresh-index.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import {
  EntryChangedError,
  type NoteFile,
  type OpenEditorsPort,
  type VaultFsPort,
} from '../vault/ports.ts';
import { markdownPathsIn } from '../types/templates.ts';
import { filesAmong, type LinkUpdatePanes } from '../vault/update-links.ts';

/** Which person to keep, and who to merge into them. */
export interface PeopleMergeRequest {
  readonly keep: VaultPath;
  readonly merge: readonly VaultPath[];
}

/** One file a merge writes: the text it was read as, and the text it will hold. */
export interface PlannedWrite {
  readonly path: VaultPath;
  readonly before: string;
  readonly after: string;
  /** How many links in it now open the kept person instead of a merged one. */
  readonly links: number;
}

/** Everything a merge would do, worked out and nothing written: what the person is asked about. */
export interface PeopleMergePreview extends PeopleMergeRequest {
  /** Why it cannot be done, or null. A refused preview has no writes. */
  readonly refusal: string | null;
  /** Whether it is refused only for typing that is not saved: once it is, it may go ahead. */
  readonly blockedByTyping: boolean;
  readonly plan: PersonMergePlan | null;
  /** Every file written, each once: the notes linking to a merged person, then the kept one. */
  readonly writes: readonly PlannedWrite[];
  /** How many links, in every note, move to the kept person. */
  readonly links: number;
  /** The merged people's own text as read: the merge goes ahead only while they still hold it. */
  readonly merged: readonly { readonly path: VaultPath; readonly text: string }[];
  /**
   * What this preview was worked out from — every file it read and the plan
   * — as one token: a confirm carrying another is not this merge (`''` when refused).
   */
  readonly version: string;
}

/** The panes, as a merge needs them: their state, their typing saved, and a clean one read again. */
export type MergePanes = Pick<OpenEditorsPort, 'state' | 'flush' | 'abandon' | 'dirtyPaths'> &
  Pick<LinkUpdatePanes, 'reload'>;

/** The ports a merge reads and writes through. */
export interface MergePorts {
  readonly fs: VaultFsPort;
  readonly index: IndexPort;
  readonly markdown: Pick<
    MarkdownPort,
    'frontmatterProperties' | 'frontmatterProblem' | 'updateFrontmatter'
  >;
  readonly editors: MergePanes;
  /**
   * Brings the index up to the files — typing just saved (`saved`, read again
   * whatever their time says), and changes another program made — or rejects
   * when it cannot. Without it the index is read as it stands.
   */
  readonly refreshIndex?: (saved: readonly VaultPath[]) => Promise<void>;
}

const refused = (
  request: PeopleMergeRequest,
  refusal: string,
  blockedByTyping = false,
): PeopleMergePreview => ({
  ...request,
  refusal,
  blockedByTyping,
  plan: null,
  writes: [],
  links: 0,
  merged: [],
  version: '',
});

/**
 * Works out a merge of people (#464) without writing anything: the kept
 * note's new properties and body, and every note whose links to a merged
 * person must open the kept one. The notes linking to them are found by the
 * index, then each is read for what it holds now. Typing not yet saved in a
 * pane on any of them is saved first, so the merge starts from it.
 */
export async function previewPeopleMerge({
  ports,
  request,
  notePaths,
}: {
  ports: MergePorts;
  request: PeopleMergeRequest;
  /** Every note in the vault, as links resolve among them. */
  notePaths: readonly VaultPath[];
}): Promise<PeopleMergePreview> {
  const stuck = await indexEveryLink(ports, request);
  if (stuck !== null) return refused(request, stuck, true);
  // Templates, saved views and dashboards are the person's own work too, and
  // few, and the index leaves them out: each is read whatever it says (#467).
  const own = (
    await Promise.all(REWRITTEN_ATLAS_FOLDERS.map((folder) => markdownPathsIn(ports.fs, folder)))
  ).flat();
  const linking = [...(await notesLinkingTo(ports.index, request.merge)), ...own];
  const holders = [...new Set(linking)].filter(
    (path) => path !== request.keep && !request.merge.includes(path),
  );
  const theirs = holders.filter((path) => !isUserSpaceNote(path) && !isRewrittenAtlasNote(path));
  if (theirs.length > 0) return refused(request, atlasOwnRefusal(theirs, request.merge));
  const involved = [request.keep, ...request.merge, ...holders];
  await saveTyping(ports.editors, involved);
  const unsaved = involved.filter((path) => ports.editors.state(path) === 'dirty');
  if (unsaved.length > 0) {
    return refused(
      request,
      `${unsaved.join(', ')} ${unsaved.length === 1 ? 'has' : 'have'} unsaved changes. Save them first.`,
      true,
    );
  }
  const files = new Map((await ports.fs.readNotes(involved)).map((file) => [file.path, file]));
  const read = readPeople({ markdown: ports.markdown, files, request });
  if (typeof read === 'string') return refused(request, read);
  const refusal = personMergeRefusal(read);
  if (refusal !== null) return refused(request, refusal);

  const across = notesAfterMerge({
    notes: notePaths,
    into: new Map(request.merge.map((path) => [path, request.keep])),
  });
  const plan = planPersonMerge({ ...read, resolve: createWikiLinkResolver(notePaths) });
  const kept = await keptWrite({ ports, files, request, plan, across });
  const rewritten = holders.flatMap((path) => holderWrite(files.get(path), across));
  // A view or dashboard may name them where no link is: a query comparing a path.
  const after = new Map(rewritten.map((write) => [write.path, write.after]));
  const unsafe = holders.filter(
    (path) =>
      !isUserSpaceNote(path) &&
      stillNames(after.get(path) ?? files.get(path)?.text ?? '', request.merge),
  );
  if (unsafe.length > 0) return refused(request, unsafeViewRefusal(unsafe, request.merge));
  const writes = [...rewritten, ...(kept === null ? [] : [kept])];
  const merged = request.merge.map((path) => ({ path, text: files.get(path)?.text ?? '' }));
  return {
    ...request,
    refusal: null,
    blockedByTyping: false,
    plan,
    writes,
    links: writes.reduce((sum, write) => sum + write.links, 0),
    merged,
    version: mergeVersion({
      read: [...merged, ...writes.map(({ path, before }) => ({ path, text: before }))],
      plan,
    }),
  };
}

/**
 * Makes the index hold every link to a merged person before it is asked for
 * them: typing in any pane — on any note, since one may have just typed
 * `[[Mara]]` anywhere — is saved, and the index brought up to the files.
 */
async function indexEveryLink(
  ports: MergePorts,
  request: PeopleMergeRequest,
): Promise<string | null> {
  const dirty = dirtyNow(ports.editors, request);
  if (dirty.length > 0) await ports.editors.flush(dirty);
  // A refused save leaves its pane dirty, and `flush` settles all the same.
  const stuck = dirtyNow(ports.editors, request);
  if (stuck.length > 0) return stuckTypingRefusal(stuck, request.merge);
  await ports.refreshIndex?.(dirty);
  return null;
}

/** Every note a pane holds unsaved typing in, the people merging among them. */
function dirtyNow(editors: MergePanes, request: PeopleMergeRequest): VaultPath[] {
  const dirty = new Set<VaultPath>(editors.dirtyPaths?.() ?? []);
  for (const path of [request.keep, ...request.merge]) {
    if (editors.state(path) === 'dirty') dirty.add(path);
  }
  return [...dirty];
}

/** Why a merge waits while typing could not be saved: it may hold a link the merge must move. */
function stuckTypingRefusal(paths: readonly VaultPath[], merge: readonly VaultPath[]): string {
  const people = merge.map(noteTitle).join(', ');
  return (
    `${paths.join(', ')} ${paths.length === 1 ? 'has' : 'have'} typing that couldn't be saved — ` +
    `it may link to ${people}. Save it, then merge.`
  );
}

/** The folders of DFAI's own a merge rewrites links in: the person's templates, views and dashboards. */
const REWRITTEN_ATLAS_FOLDERS = [TEMPLATES_DIRECTORY, VIEWS_DIRECTORY, DASHBOARDS_DIRECTORY].map(
  createVaultPath,
);

const isRewrittenAtlasNote = (path: VaultPath) =>
  REWRITTEN_ATLAS_FOLDERS.some((folder) =>
    path.toLowerCase().startsWith(`${folder.toLowerCase()}/`),
  );

/**
 * Whether text still names a merged person by their file once its links are
 * re-pointed — a view's SQL comparing a path, say — which no link rewrite
 * reaches. Only a whole path counts, case aside: `People/Tobias Fenn.md`
 * does not name `Tobias Fenn.md`, nor `Diana.md` `Ana.md`.
 */
function stillNames(text: string, merge: readonly VaultPath[]): boolean {
  return merge.some((path) => wholePath(path).test(text));
}

/** A path, matched only where no other path character runs on before or after it. */
function wholePath(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_./-])${escaped}(?![\\p{L}\\p{N}\\p{M}_/-])`, 'iu');
}

/** Why a merge is refused while a view or dashboard names a merged person in a way it cannot rewrite. */
function unsafeViewRefusal(paths: readonly VaultPath[], merge: readonly VaultPath[]): string {
  const people = merge.map(noteTitle).join(', ');
  return (
    `${paths.join(', ')} ${paths.length === 1 ? 'names' : 'name'} ${people} by file, not by a link, ` +
    'so the merge cannot change it safely. Change it by hand, then merge.'
  );
}

/** Why a merge is refused while one of DFAI's own files links to a merged person. */
function atlasOwnRefusal(paths: readonly VaultPath[], merge: readonly VaultPath[]): string {
  const files = paths.join(', ');
  const people = merge.map(noteTitle).join(', ');
  return (
    `${files} ${paths.length === 1 ? 'links' : 'link'} to ${people} but ` +
    `${paths.length === 1 ? 'is one' : 'are'} of DFAI's own files, which a merge does not rewrite. ` +
    'Change those links by hand, then merge.'
  );
}

async function saveTyping(editors: MergePanes, paths: readonly VaultPath[]): Promise<void> {
  const dirty = paths.filter((path) => editors.state(path) === 'dirty');
  if (dirty.length > 0) await editors.flush(dirty);
}

/** The kept and merged people as the plan reads them, or why one cannot be read. */
function readPeople({
  markdown,
  files,
  request,
}: {
  markdown: MergePorts['markdown'];
  files: ReadonlyMap<string, NoteFile>;
  request: PeopleMergeRequest;
}): { kept: MergeNote; duplicates: MergeNote[] } | string {
  const notes: MergeNote[] = [];
  for (const path of [request.keep, ...request.merge]) {
    const file = files.get(path);
    if (file === undefined) return `${noteTitle(path)} is not there, or cannot be read.`;
    const { frontmatter, body } = splitFrontmatter(file.text);
    const problem = markdown.frontmatterProblem(frontmatter);
    if (problem !== null) return `${noteTitle(path)}’s properties can’t be read: ${problem}`;
    notes.push({
      path,
      body,
      properties: markdown.frontmatterProperties(frontmatter, { forWriting: true }),
    });
  }
  const [kept, ...duplicates] = notes;
  return { kept: kept!, duplicates };
}

/** A note linking to a merged person, with its links re-pointed — or nothing, when none needs to be. */
function holderWrite(file: NoteFile | undefined, across: NotesAcrossMove): PlannedWrite[] {
  if (file === undefined) return [];
  const { text, count } = retargetMergedLinks({ text: file.text, ...across });
  return count === 0
    ? []
    : [{ path: file.path as VaultPath, before: file.text, after: text, links: count }];
}

/**
 * The kept note as merged: its frontmatter with the plan's changes, written
 * byte-preservingly; its body with each merged body after it, their image
 * sources re-pointed from where they were; then every link in it re-pointed
 * — a merged body's link to its own note included.
 */
async function keptWrite({
  ports,
  files,
  request,
  plan,
  across,
}: {
  ports: MergePorts;
  files: ReadonlyMap<string, NoteFile>;
  request: PeopleMergeRequest;
  plan: PersonMergePlan;
  across: NotesAcrossMove;
}): Promise<PlannedWrite | null> {
  const before = files.get(request.keep)!.text;
  const document = splitFrontmatter(before);
  const changed = Object.keys(plan.changes).length > 0;
  const frontmatter = changed
    ? ports.markdown.updateFrontmatter(document.frontmatter, plan.changes)
    : document.frontmatter;
  const appended = await rebasedBodies({ fs: ports.fs, plan, into: request.keep });
  const body = mergedBody(document.body, appended);
  const { text: after, count } = retargetMergedLinks({
    text: joinFrontmatter(frontmatter, body),
    ...across,
  });
  return after === before ? null : { path: request.keep, before, after, links: count };
}

/** Each merged body with its relative image sources pointing where they did from the merged note. */
async function rebasedBodies({
  fs,
  plan,
  into,
}: {
  fs: VaultFsPort;
  plan: PersonMergePlan;
  into: VaultPath;
}): Promise<PersonMergePlan['appended']> {
  const wanted = plan.appended.flatMap(({ body, from }) =>
    imagePathsToRebase({ text: body, from, to: into }),
  );
  const existing =
    wanted.length === 0 ? new Set<VaultPath>() : await filesAmong({ fs, paths: wanted });
  return plan.appended.map((section) => ({
    ...section,
    body: rebaseImageSources({
      text: section.body,
      from: section.from,
      to: into,
      exists: (path) => existing.has(path),
    }).text,
  }));
}

/** A merge not started: a note changed, or was being typed in, after the preview. Nothing was written. */
export class PeopleMergeChangedError extends Error {
  constructor(readonly paths: readonly VaultPath[]) {
    super(
      `${paths.join(', ')} changed after the merge was previewed, so nothing was merged. Preview it again.`,
    );
    this.name = 'PeopleMergeChangedError';
  }
}

/** A merge refused before anything was written. */
export class PeopleMergeRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PeopleMergeRefusedError';
  }
}

/** A step of a merge that did not happen, and why. */
export interface MergeFailure {
  readonly path: VaultPath;
  readonly step: 'write' | 'trash';
  readonly reason: string;
}

/** What a merge did, file by file: every file is either changed whole or left exactly as it was. */
export interface PeopleMergeReport {
  readonly keep: VaultPath;
  readonly written: readonly VaultPath[];
  /** Planned writes not made, because an earlier one failed. */
  readonly notWritten: readonly VaultPath[];
  readonly trashed: readonly VaultPath[];
  /** Merged people still in the vault: their links may not all have moved yet. */
  readonly notTrashed: readonly VaultPath[];
  readonly failures: readonly MergeFailure[];
  /** How many links now open the kept person, counted from the notes written. */
  readonly links: number;
}

/**
 * Makes a merge the person confirmed (#464), from its preview.
 *
 * Nothing is written unless every file still holds what the preview read
 * and no pane holds unsaved typing in one: otherwise {@link PeopleMergeChangedError}.
 * Then each file is written once, whole, guarded by the host against a
 * change in between: the notes linking to a merged person first, the kept
 * note next, so a link never opens nothing — until the last write, a link
 * opens the merged person, who is still there. The merged people go to the
 * Trash only once every write has landed.
 *
 * A write that fails stops the merge where it is: the report names what was
 * written, what was not, and that the merged people were kept. A merge
 * previewed again picks up from there: links already moved need nothing,
 * and the kept note is merged once.
 */
export async function applyPeopleMerge({
  ports,
  preview,
}: {
  ports: MergePorts;
  preview: PeopleMergePreview;
}): Promise<PeopleMergeReport> {
  if (preview.refusal !== null) throw new PeopleMergeRefusedError(preview.refusal);
  const versions = await currentVersions({ ports, preview });
  const written: VaultPath[] = [];
  const failures: MergeFailure[] = [];
  for (const write of preview.writes) {
    try {
      const expectedModified = versions.get(write.path) ?? null;
      await ports.fs.writeTextFile({
        path: write.path,
        contents: write.after,
        expectedModified,
        expectedText: write.before,
      });
      written.push(write.path);
    } catch (cause) {
      failures.push({ path: write.path, step: 'write', reason: reasonOf(cause) });
      break;
    }
  }
  reloadClean(ports.editors, written);
  const notWritten = preview.writes
    .map((write) => write.path)
    .filter((path) => !written.includes(path));
  const trashed = failures.length === 0 ? await trashMerged({ ports, preview, failures }) : [];
  return {
    keep: preview.keep,
    written,
    notWritten,
    trashed,
    notTrashed: preview.merge.filter((path) => !trashed.includes(path)),
    failures,
    links: preview.writes
      .filter((write) => written.includes(write.path))
      .reduce((sum, write) => sum + write.links, 0),
  };
}

/** Why a merged person was left in the vault: their note changed while the merge was written. */
const CHANGED_BEFORE_TRASH =
  'It changed while the merge was being written, so it was left where it is. Merge it again to take in the change.';

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Each file's modification time as it is read now, once it is known that
 * every file the merge writes or takes still holds what the preview read —
 * and that no pane is being typed in on one.
 */
async function currentVersions({
  ports,
  preview,
}: {
  ports: MergePorts;
  preview: PeopleMergePreview;
}): Promise<Map<VaultPath, number>> {
  const expected = new Map<VaultPath, string>([
    ...preview.merged.map(({ path, text }) => [path, text] as const),
    ...preview.writes.map(({ path, before }) => [path, before] as const),
  ]);
  const paths = [...expected.keys()];
  const typing = paths.filter((path) => ports.editors.state(path) === 'dirty');
  const files = new Map((await ports.fs.readNotes(paths)).map((file) => [file.path, file]));
  const changed = paths.filter((path) => files.get(path)?.text !== expected.get(path));
  const stale = [...new Set([...typing, ...changed])];
  if (stale.length > 0) throw new PeopleMergeChangedError(stale);
  return new Map(paths.map((path) => [path, files.get(path)!.modified]));
}

function reloadClean(editors: MergePanes, paths: readonly VaultPath[]): void {
  for (const path of paths) if (editors.state(path) === 'clean') editors.reload(path);
}

/** Puts each merged person in the Trash, noting any the Trash refused, and lets go of the ones gone. */
async function trashMerged({
  ports,
  preview,
  failures,
}: {
  ports: MergePorts;
  preview: PeopleMergePreview;
  failures: MergeFailure[];
}): Promise<VaultPath[]> {
  const trashed: VaultPath[] = [];
  const read = new Map((await ports.fs.readNotes(preview.merge)).map((file) => [file.path, file]));
  for (const { path, text } of preview.merged) {
    const file = read.get(path);
    if (file?.text !== text) {
      failures.push({ path, step: 'trash', reason: CHANGED_BEFORE_TRASH });
      continue;
    }
    try {
      // Held to the version just checked, so an edit landing before the Trash keeps the note (#693).
      await ports.fs.trashEntry({ path, unchanged: [{ path, modified: file.modified, text }] });
      trashed.push(path);
    } catch (cause) {
      const reason = cause instanceof EntryChangedError ? CHANGED_BEFORE_TRASH : reasonOf(cause);
      failures.push({ path, step: 'trash', reason });
    }
  }
  ports.editors.abandon(trashed);
  // Safe to let go of: the refresh after every change removes what is no
  // longer on disk, and re-resolves what named it, so a failure only delays it.
  await forgetNotes(ports.index, trashed).catch(() => undefined);
  return trashed;
}

const many = (count: number, one: string, more: string) => `${count} ${count === 1 ? one : more}`;
const names = (paths: readonly VaultPath[]) => paths.map(noteTitle).join(', ');

/**
 * What a merge did, in one line for its toast and the Activity log: who went
 * into whom and how many links moved — or, when it stopped, what was written,
 * what was not, and who is still in the vault.
 */
export function peopleMergeSummary(report: PeopleMergeReport): string {
  const kept = noteTitle(report.keep);
  const failed = report.failures.find((failure) => failure.step === 'write');
  if (failed !== undefined) {
    const written =
      report.written.length === 0 ? 'Nothing was written' : `Written: ${report.written.join(', ')}`;
    return (
      `The merge into ${kept} stopped: ${failed.path} could not be written (${failed.reason}). ` +
      `${written}. Not written: ${report.notWritten.join(', ')}. Nobody went to the Trash.`
    );
  }
  const who = names(report.trashed.length > 0 ? report.trashed : report.notTrashed);
  const moved =
    report.links === 0 ? '' : `: ${many(report.links, 'link', 'links')} now open ${kept}`;
  const merged = `Merged ${who} into ${kept}${moved}.`;
  const refused = report.failures.filter((failure) => failure.step === 'trash');
  if (refused.length === 0) return merged;
  const left = refused.map(({ path, reason }) => `${path} (${reason})`).join(', ');
  return `${merged} Still in the vault, as the Trash refused: ${left}.`;
}
