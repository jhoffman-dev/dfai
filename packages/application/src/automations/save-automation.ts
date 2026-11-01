import {
  AUTOMATIONS_DIRECTORY,
  automationFrontmatter,
  automationIdFor,
  automationNameProblem,
  automationPathFor,
  builtInPromptAt,
  createVaultPath,
  parentVaultPath,
  draftProblem,
  logPathFor,
  opensUnclosedFrontmatter,
  splitFrontmatter,
  type AutomationDraft,
  type AutomationRule,
  type VaultPath,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import type { Clock } from '../ports.ts';
import { UnclosedFrontmatterError } from '../query/set-property.ts';
import { ensureFolder } from '../vault/create-folder.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { appendToRuleLog } from './automation-log.ts';

export class AutomationRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AutomationRefusedError';
  }
}

interface RuleWrite {
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  readonly clock: Pick<Clock, 'now' | 'localNow'>;
}

/**
 * Writes a new automation into `.atlas/automations/`, named for it. A rule
 * that starts out on is logged as turned on, so a daily rule made in the
 * afternoon runs at its next time even if DFAI is closed until after it.
 */
export async function createAutomation({
  draft,
  takenPaths,
  ...write
}: RuleWrite & {
  draft: AutomationDraft;
  /** Every note's path, so a name already taken is refused before the write. */
  takenPaths: readonly string[];
}): Promise<VaultPath> {
  const problem = automationNameProblem(draft.name, takenPaths) ?? draftProblem(draft);
  if (problem !== null) throw new AutomationRefusedError(problem);
  await ensureFolder({ fs: write.fs, folder: createVaultPath(AUTOMATIONS_DIRECTORY) });
  const path = automationPathFor(draft.name);
  const id = await freeId(write.fs, draft.name);
  const head = write.markdown.updateFrontmatter(null, {
    ...withoutEmpty(automationFrontmatter(draft)),
    id,
  });
  await ensureBuiltInPrompt(write.fs, draft);
  // A heading, so the file reads as what it is anywhere else; below it is the person's own.
  await write.fs.createNote({ path, contents: `${head}\n# ${draft.name.trim()}\n` });
  if (draft.enabled) await logTurnedOn({ ...write, rule: { id, name: draft.name.trim() } });
  return path;
}

/**
 * An id for a new rule that no log is kept under yet: a log left by a
 * deleted rule of the same name is that rule's history, not this one's.
 */
async function freeId(fs: VaultFsPort, name: string): Promise<string> {
  const taken: string[] = [];
  for (;;) {
    const id = automationIdFor(name, taken);
    const [log] = await fs.readNotes([logPathFor(id)]);
    if (log === undefined) return id;
    taken.push(id);
  }
}

/**
 * Rewrites a rule's frontmatter to the editor's, keeping the file's body — the
 * person's notes about the rule — byte for byte. The file keeps its name, so
 * its log stays its log.
 */
export async function updateAutomation({
  rule,
  draft,
  ...write
}: RuleWrite & { rule: AutomationRule; draft: AutomationDraft }): Promise<void> {
  const problem = draft.name.trim() === '' ? 'Name the automation.' : draftProblem(draft);
  if (problem !== null) throw new AutomationRefusedError(problem);
  await ensureBuiltInPrompt(write.fs, draft);
  const { text, modified } = await write.fs.readTextFile(rule.path);
  // Unclosed since it was read: a block on top would hold only the edit (#683).
  if (opensUnclosedFrontmatter(text)) throw new UnclosedFrontmatterError(rule.path);
  const document = splitFrontmatter(text);
  const frontmatter = write.markdown.updateFrontmatter(document.frontmatter, {
    ...automationFrontmatter(draft),
    id: rule.id,
  });
  await write.fs.writeTextFile({
    path: rule.path,
    contents: frontmatter + document.body,
    expectedModified: modified,
  });
  if (draft.enabled && !rule.enabled) {
    await logTurnedOn({ ...write, rule: { id: rule.id, name: draft.name.trim() } });
  }
}

/**
 * Writes the prompt a rule's Claude step names when it is one DFAI ships and
 * the vault has no note there (P29-05) — so a ready-made rule runs as saved.
 * A prompt that is there is the person's, edited or not, and is left as it is.
 */
async function ensureBuiltInPrompt(fs: VaultFsPort, { action }: AutomationDraft): Promise<void> {
  if (action.kind === 'claude') await ensureShippedPrompt(fs, action.prompt);
}

/**
 * Writes the prompt DFAI ships at `path` where the vault has no note there;
 * a path DFAI ships nothing at, or a note already there, is left alone.
 */
export async function ensureShippedPrompt(fs: VaultFsPort, path: string): Promise<void> {
  const prompt = builtInPromptAt(path);
  if (prompt === null) return;
  const [held] = await fs.readNotes([prompt.path]);
  if (held !== undefined) return;
  await ensureFolder({ fs, folder: parentVaultPath(prompt.path) });
  try {
    await fs.createNote({ path: prompt.path, contents: prompt.contents });
  } catch (cause) {
    // A note written meanwhile (a sync, another save) is the person's: kept, and the rule runs as saved.
    // Any other failure is real, and the rule is not saved without its prompt.
    const [written] = await fs.readNotes([prompt.path]);
    if (written === undefined) throw cause;
  }
}

async function logTurnedOn({
  fs,
  clock,
  rule,
}: Pick<RuleWrite, 'fs' | 'clock'> & { rule: Pick<AutomationRule, 'id' | 'name'> }) {
  await appendToRuleLog({
    fs,
    rule,
    entry: { kind: 'turnedOn', at: clock.localNow() },
    now: clock.now(),
  });
}

/** A new file has nothing to take out: keys with no value are simply not written. */
function withoutEmpty(frontmatter: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(frontmatter).filter(([, value]) => value !== null));
}
