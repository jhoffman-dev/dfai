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
  parseAutomationRule,
  sameAutomation,
  splitFrontmatter,
  type AutomationDraft,
  type AutomationRule,
  type VaultPath,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import type { Clock } from '../ports.ts';
import { UnclosedFrontmatterError } from '../query/set-property.ts';
import { readSettingsBlock } from '../notes/settings-block.ts';
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
 * its log stays its log. A rule whose file says something else now than when
 * it was read — another editor, the other Mac's sync — is refused, never
 * written over (#793). Its on or off is the editor's only when the person
 * changed it there; otherwise the file's, so a switch since is not undone.
 */
export async function updateAutomation({
  rule,
  draft,
  ...write
}: RuleWrite & { rule: AutomationRule; draft: AutomationDraft }): Promise<void> {
  const problem = draft.name.trim() === '' ? 'Name the automation.' : draftProblem(draft);
  if (problem !== null) throw new AutomationRefusedError(problem);
  await ensureBuiltInPrompt(write.fs, draft);
  const { text, modified, now } = await readUnchanged(write, rule);
  const enabled = draft.enabled === rule.enabled ? now.enabled : draft.enabled;
  const document = splitFrontmatter(text);
  const frontmatter = write.markdown.updateFrontmatter(document.frontmatter, {
    ...automationFrontmatter({ ...draft, enabled }),
    id: rule.id,
  });
  await write.fs.writeTextFile({
    path: rule.path,
    contents: frontmatter + document.body,
    expectedModified: modified,
  });
  if (enabled && !now.enabled) {
    await logTurnedOn({ ...write, rule: { id: rule.id, name: draft.name.trim() } });
  }
}

/**
 * Turns a rule on or off: only its `enabled` is written, onto the file as it
 * is now, so whatever else was edited there since the rule was read stays
 * (#793). Turning one on is logged, as a save that turns it on is.
 */
export async function setAutomationEnabled({
  rule,
  enabled,
  ...write
}: RuleWrite & { rule: AutomationRule; enabled: boolean }): Promise<void> {
  const { text, modified } = await write.fs.readTextFile(rule.path);
  if (opensUnclosedFrontmatter(text)) throw new UnclosedFrontmatterError(rule.path);
  const now = ruleIn(write.markdown, rule.path, text);
  if (now === null) throw changedOnDisk(rule);
  const document = splitFrontmatter(text);
  const frontmatter = write.markdown.updateFrontmatter(document.frontmatter, { enabled });
  await write.fs.writeTextFile({
    path: rule.path,
    contents: frontmatter + document.body,
    expectedModified: modified,
  });
  if (enabled && !now.enabled)
    await logTurnedOn({ ...write, rule: { id: now.id, name: now.name } });
}

/** The rule's file, read now, and the rule it says, when that is still the rule it was read as; refused otherwise. */
async function readUnchanged(
  write: RuleWrite,
  rule: AutomationRule,
): Promise<{ text: string; modified: number; now: AutomationRule }> {
  const read = await write.fs.readTextFile(rule.path);
  // Unclosed since it was read: a block on top would hold only the edit (#683).
  if (opensUnclosedFrontmatter(read.text)) throw new UnclosedFrontmatterError(rule.path);
  const now = ruleIn(write.markdown, rule.path, read.text);
  if (now === null || !sameAutomation(now, rule)) throw changedOnDisk(rule);
  return { ...read, now };
}

/** The rule a file's text says, or null when it says none that reads. */
function ruleIn(markdown: MarkdownPort, path: VaultPath, text: string): AutomationRule | null {
  const block = readSettingsBlock(markdown, text);
  if ('problem' in block) return null;
  const read = parseAutomationRule(path, block.properties);
  return 'rule' in read ? read.rule : null;
}

const changedOnDisk = (rule: AutomationRule) =>
  new AutomationRefusedError(
    `“${rule.name}” was changed on disk since it was read, so it was not saved: look at it again, then save.`,
  );

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
