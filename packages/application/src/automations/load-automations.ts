import {
  automationIdKey,
  createVaultPath,
  isAutomationNote,
  isAutomationPath,
  isBlankFrontmatter,
  noteTitle,
  opensUnclosedFrontmatter,
  parseAutomationRule,
  splitFrontmatter,
  type AutomationRule,
  type BrokenAutomation,
  type HandledLedger,
  type LogEntry,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { readRuleLog } from './automation-log.ts';

/** A rule and what its log says, as the Automations page lists it. */
export interface LoadedAutomation {
  readonly rule: AutomationRule;
  readonly log: readonly LogEntry[];
  /** What it has handled; null for a log from before the ledger. */
  readonly ledger?: HandledLedger | null;
  /** Whether its file says its id; a rule from before ids has one written for it. */
  readonly idWritten: boolean;
}

export interface AutomationListing {
  readonly automations: readonly LoadedAutomation[];
  /** Rule files that could not be read: listed with why, never run. */
  readonly broken: readonly BrokenAutomation[];
}

/**
 * Every automation in the vault, with its log, sorted by name. A file in the
 * automations folder that does not say `atlas: automation` is not a rule and
 * is left out; one that says so and cannot be read is listed as broken, and so
 * is one whose frontmatter is not readable at all.
 */
export async function loadAutomations({
  fs,
  markdown,
  notePaths,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  notePaths: readonly string[];
}): Promise<AutomationListing> {
  const rulePaths = notePaths.filter(isAutomationPath).sort();
  // Read on every minute's tick: a vault with no rules asks the host nothing.
  if (rulePaths.length === 0) return { automations: [], broken: [] };
  const files = await fs.readNotes(rulePaths);
  const automations: LoadedAutomation[] = [];
  const broken: BrokenAutomation[] = [];
  const ids = new Set<string>();
  for (const file of files) {
    const block = readRuleBlock(markdown, file.text);
    if ('problem' in block) {
      broken.push(unreadableRule(file.path, block.problem));
      continue;
    }
    const frontmatter = block.properties;
    if (!isAutomationNote(frontmatter)) continue;
    const read = parseAutomationRule(createVaultPath(file.path), frontmatter);
    if ('broken' in read) {
      broken.push(read.broken);
      continue;
    }
    const { rule, idWritten } = read;
    // A copied rule file shares its id: two rules writing one log would undo each other's runs.
    const id = automationIdKey(rule.id);
    if (ids.has(id)) {
      const problem = `Another automation has id: ${rule.id}. Give this one its own id.`;
      broken.push({ path: rule.path, name: rule.name, problem });
      continue;
    }
    ids.add(id);
    const log = await readRuleLog(fs, rule);
    automations.push({ rule, log: log.entries, ledger: log.ledger, idWritten });
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return {
    automations: automations.sort((a, b) => byName(a.rule, b.rule)),
    broken: broken.sort(byName),
  };
}

/** A rule file whose frontmatter cannot be read, named by its file as an unnamed rule is. */
function unreadableRule(path: string, problem: string): BrokenAutomation {
  const vaultPath = createVaultPath(path);
  return {
    path: vaultPath,
    name: noteTitle(vaultPath),
    problem,
  };
}

/**
 * A rules-folder file's properties, or why it has frontmatter that gives none.
 * Each of these reads as no properties, so it cannot say it is a rule: in the
 * rules folder it most likely is one, and leaving it out stops it silently (#679).
 * A file with no block, or a blank one, has nothing to say and is not a problem.
 */
function readRuleBlock(
  markdown: MarkdownPort,
  text: string,
): { properties: Readonly<Record<string, unknown>> } | { problem: string } {
  if (opensUnclosedFrontmatter(text)) return { problem: 'Its frontmatter has no closing ---.' };
  const block = splitFrontmatter(text).frontmatter;
  const reason = markdown.frontmatterProblem(block);
  if (reason !== null) return { problem: `Its frontmatter is not valid YAML: ${reason}` };
  const properties = markdown.frontmatterProperties(block);
  // YAML that reads as a list or one value: as Confluence export tells it, not the port,
  // which reads such a block as none and is right to for every other note.
  if (block !== null && !isBlankFrontmatter(block) && Object.keys(properties).length === 0) {
    return { problem: 'Its frontmatter is not a set of properties.' };
  }
  return { properties };
}
