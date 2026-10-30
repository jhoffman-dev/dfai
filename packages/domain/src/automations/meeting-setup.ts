import { TASK_TYPE } from '../gtd/gtd-status.ts';
import { MEETING_TYPE } from '../meetings/meeting-header.ts';
import {
  MEETING_EXTRACTION_PROPERTIES,
  MEETING_ITEM_TASK_PROPERTIES,
} from '../meetings/meeting-extraction-properties.ts';
import { MEETING_IMPORT_PROPERTIES } from '../meetings/meeting-import-properties.ts';
import { MEETING_SUMMARY_PROPERTIES } from '../meetings/meeting-summary-block.ts';
import {
  GRANOLA_SELF_EMAILS_KEY,
  SELF_EMAILS_KEY,
  type SelfEmails,
} from '../profile/self-emails.ts';
import { typeGainingKeys } from '../types/inbox-setup.ts';
import { extensionKeys, extensionWithin, type TypeExtension } from '../types/para.ts';
import type { ObjectType, PropertyDef } from '../types/property-def.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import { automationNameProblem, type AutomationDraft } from './automation-rule.ts';
import { isDeclaredStep } from './claude-step-budget.ts';
import { AFTER_A_MEETING_PROMPT } from './built-in-prompts.ts';
import { MEETING_DIGEST_OUTPUT } from './meeting-digest.ts';
import { AFTER_A_MEETING_PRESET } from './presets.ts';

/** What the setup of meeting post-processing reads of a vault before it offers anything (#191). */
export interface MeetingSetupFacts<Type extends ObjectType = ObjectType> {
  /** The vault's types, as their files define them. */
  readonly types: readonly Type[];
  /** The vault's rules, as their files say. */
  readonly rules: readonly Pick<AutomationDraft, 'name' | 'enabled' | 'action' | 'when'>[];
  /** Every note's path: a rule file already called "After a meeting" is not written over. */
  readonly takenPaths: readonly string[];
  /** Whether a note is at the prompt's path, the person's own or DFAI's. */
  readonly promptHeld: boolean;
  /** The owner's addresses as the vault's settings hold them. */
  readonly selfEmails: SelfEmails;
}

/** One thing the preview lists: what would be written, or what is skipped and why. */
export interface MeetingSetupLine {
  /** Which part of the setup it is: the emails' line is where the preview asks for them. */
  readonly kind: 'rule' | 'prompt' | 'type' | 'emails';
  /** What it is: "The “After a meeting” rule". */
  readonly what: string;
  /** What is written, or why nothing is. */
  readonly detail: string;
  /** False when it is already there, or cannot be done: nothing is written for it. */
  readonly written: boolean;
  /** True when it cannot be done (a file in the way, a type missing or claimed twice), not merely there. */
  readonly blocked: boolean;
}

/** Something the preview said would be written that can no longer be, and why. */
export interface MeetingSetupLoss {
  readonly what: string;
  readonly reason: string;
}

/** What one yes would write to set up meeting post-processing (ADR-0036). */
export interface MeetingSetupPlan<Type extends ObjectType = ObjectType> {
  /** The rule to write; null when one is there. */
  readonly rule: AutomationDraft | null;
  /** The prompt DFAI ships, to write where no note is; null when one is, or no rule names it. */
  readonly prompt: VaultPath | null;
  /** The Meeting and Task types' changes: only the keys each lacks. */
  readonly extensions: readonly TypeExtension<Type>[];
  /** Whether the owner's addresses are asked for: none is saved as `selfEmails` yet. */
  readonly asksEmails: boolean;
  /** Everything the preview says, in the order it is written. */
  readonly lines: readonly MeetingSetupLine[];
  /** Whether a rule that post-processes meetings is there and on, before the yes. */
  readonly ruleOn: boolean;
}

type RuleFacts = Pick<AutomationDraft, 'enabled' | 'action' | 'when'>;

/**
 * Whether a rule post-processes a meeting as it arrives: the declared step
 * (`apply: mine`, under whatever name) set off by a meeting being created. One
 * that runs by hand or on a schedule does not, so it is not counted as set up.
 */
function processesArrivals({ action, when }: RuleFacts): boolean {
  return (
    isDeclaredStep(action) &&
    when.kind === 'note' &&
    folded(when.type) === MEETING_TYPE &&
    when.on.includes('created')
  );
}

/** Whether a rule that is on post-processes meetings as they arrive: then nothing is to be offered. */
export function meetingsProcessedOnArrival(rules: readonly RuleFacts[]): boolean {
  return rules.some((rule) => rule.enabled && processesArrivals(rule));
}

/** The keys the Meeting type needs for the import, the step's links and its summary block. */
const MEETING_KEYS: readonly PropertyDef[] = [
  ...MEETING_IMPORT_PROPERTIES,
  ...MEETING_EXTRACTION_PROPERTIES,
  ...MEETING_SUMMARY_PROPERTIES,
];

const RULE_WHAT = `The “${AFTER_A_MEETING_PRESET.name}” rule`;

/**
 * What one yes would write to make a meeting post-processed when it arrives
 * (#191): the "After a meeting" rule, its prompt, the Meeting type's keys
 * (`tasks`, `decisions`, the summary's and the import's), the Task type's
 * `meeting` and `atlas_item`, and the owner's addresses. Each is left out
 * where it is already there; nothing here is written without the yes
 * (ADR-0028). It builds on the Inbox's own offer of keys
 * ({@link typeGainingKeys}): additive only, never on a type two files claim.
 */
export function meetingSetupPlan<Type extends ObjectType>(
  facts: MeetingSetupFacts<Type>,
): MeetingSetupPlan<Type> {
  const rule = rulePlan(facts);
  const prompt = promptPlan(facts, rule.draft);
  const meeting = typePlan(facts.types, {
    name: MEETING_TYPE,
    label: 'Meeting',
    keys: MEETING_KEYS,
  });
  const task = typePlan(facts.types, {
    name: TASK_TYPE,
    label: 'Task',
    keys: MEETING_ITEM_TASK_PROPERTIES,
  });
  const emails = emailsLine(facts.selfEmails);
  return {
    rule: rule.draft,
    prompt: prompt.path,
    extensions: [meeting.extension, task.extension].flatMap((one) => (one === null ? [] : [one])),
    asksEmails: emails.written,
    ruleOn: meetingsProcessedOnArrival(facts.rules),
    lines: [
      rule.line,
      ...(prompt.line === null ? [] : [prompt.line]),
      meeting.line,
      task.line,
      emails,
    ],
  };
}

/** Whether a yes on this plan would write nothing at all: the emails field counts. */
export function meetingSetupWritesNothing(plan: MeetingSetupPlan): boolean {
  return (
    plan.rule === null && plan.prompt === null && plan.extensions.length === 0 && !plan.asksEmails
  );
}

function rulePlan(facts: MeetingSetupFacts): {
  draft: AutomationDraft | null;
  line: MeetingSetupLine;
} {
  const existing = facts.rules.find(processesArrivals);
  if (existing !== undefined) {
    const off = existing.enabled ? '' : ' It is turned off: turn it on in Automations.';
    const detail = `Already there, as “${existing.name}”.${off}`;
    return {
      draft: null,
      line: { kind: 'rule', what: RULE_WHAT, detail, written: false, blocked: false },
    };
  }
  const taken = automationNameProblem(AFTER_A_MEETING_PRESET.name, facts.takenPaths);
  if (taken !== null) {
    return {
      draft: null,
      line: {
        kind: 'rule',
        what: RULE_WHAT,
        detail: `${taken} It is left as it is.`,
        written: false,
        blocked: true,
      },
    };
  }
  return {
    draft: AFTER_A_MEETING_PRESET,
    line: { kind: 'rule', what: RULE_WHAT, detail: RULE_DETAIL, written: true, blocked: false },
  };
}

/** The rule as the preview lists it: what it does, then what its file says. */
const RULE_DETAIL = [
  'When a meeting arrives, Claude summarises it and makes your own action items tasks.',
  `prompt: ${AFTER_A_MEETING_PROMPT}, output: ${MEETING_DIGEST_OUTPUT}, apply: mine,`,
  `which: ${AFTER_A_MEETING_PRESET.which} (meetings of the last 14 days).`,
].join(' ');

/**
 * The prompt DFAI ships for the rule, where no note is at its path: offered
 * when the rule to write names it, or the one there does. A rule naming a
 * prompt of the person's own is not given DFAI's.
 */
function promptPlan(
  facts: MeetingSetupFacts,
  draft: AutomationDraft | null,
): { path: VaultPath | null; line: MeetingSetupLine | null } {
  const named = [draft, ...facts.rules.filter(processesArrivals)].some(
    (rule) =>
      rule !== null &&
      rule.action.kind === 'claude' &&
      rule.action.prompt === AFTER_A_MEETING_PROMPT,
  );
  if (!named) return { path: null, line: null };
  const what = `The prompt ${AFTER_A_MEETING_PROMPT}`;
  if (facts.promptHeld) {
    return {
      path: null,
      line: {
        kind: 'prompt',
        what,
        detail: 'Already there: kept as it is.',
        written: false,
        blocked: false,
      },
    };
  }
  const detail = 'What Claude is asked of each meeting, as DFAI ships it.';
  return {
    path: AFTER_A_MEETING_PROMPT,
    line: { kind: 'prompt', what, detail, written: true, blocked: false },
  };
}

/** A vault's type name as the disk compares its file's: in any case. */
const folded = (name: string) => name.trim().toLowerCase();

function typePlan<Type extends ObjectType>(
  types: readonly Type[],
  wanted: { name: string; label: string; keys: readonly PropertyDef[] },
): { extension: TypeExtension<Type> | null; line: MeetingSetupLine } {
  const what = `The ${wanted.label} type`;
  const claimed = types.filter((type) => folded(type.name) === wanted.name);
  const [only] = claimed;
  if (only === undefined) {
    const detail = `The vault has no ${wanted.label} type, so it gains nothing: ${keyList(wanted.keys)} are added by setting up again once it has one.`;
    return { extension: null, line: { kind: 'type', what, detail, written: false, blocked: true } };
  }
  if (claimed.length > 1) {
    const detail = `Two files define the ${wanted.label} type: merge them, then set up again.`;
    return { extension: null, line: { kind: 'type', what, detail, written: false, blocked: true } };
  }
  const extension = typeGainingKeys(only, wanted.keys);
  if (extension === null) {
    return {
      extension: null,
      line: {
        kind: 'type',
        what,
        detail: 'Already has every key it needs.',
        written: false,
        blocked: false,
      },
    };
  }
  return {
    extension,
    line: {
      kind: 'type',
      what,
      detail: `Gains ${keyList(extension.added)}.`,
      written: true,
      blocked: false,
    },
  };
}

const keyList = (keys: readonly PropertyDef[]) => keys.map((property) => property.key).join(', ');

function emailsLine({ emails, source, problem }: SelfEmails): MeetingSetupLine {
  const line = (detail: string, written: boolean): MeetingSetupLine => ({
    kind: 'emails',
    what: 'Your email addresses',
    detail,
    written,
    blocked: false,
  });
  const listed = emails.join(', ');
  if (problem !== null) {
    return line(
      `${source} in your settings can’t be read (${problem}): what you type here replaces it as ${SELF_EMAILS_KEY}.`,
      true,
    );
  }
  if (source === SELF_EMAILS_KEY && emails.length > 0) {
    return line(`Already saved as ${SELF_EMAILS_KEY}: ${listed}.`, false);
  }
  const why = `Saved as ${SELF_EMAILS_KEY}, so DFAI can tell which action items are yours.`;
  if (source === GRANOLA_SELF_EMAILS_KEY) {
    return line(
      `${why} In use now from ${GRANOLA_SELF_EMAILS_KEY}: ${listed}. What you type is saved as ${SELF_EMAILS_KEY} and ${GRANOLA_SELF_EMAILS_KEY} is removed; left empty, both stay as they are.`,
      true,
    );
  }
  return line(
    `${why} Left empty, nothing is saved: your Person note’s addresses are used if it has any, and otherwise your name alone.`,
    true,
  );
}

/**
 * What of `shown` a plan worked out again now still writes — and no more than
 * `shown` did: an item is written only when the preview listed it and it is
 * still missing, and a type gains only keys the preview named for it. So a
 * rule, prompt or key that arrived while the preview waited is not written
 * twice, and nothing the person was not shown is written at all.
 */
export function meetingSetupWithin<Type extends ObjectType>(
  shown: MeetingSetupPlan<ObjectType>,
  now: MeetingSetupPlan<Type>,
): MeetingSetupPlan<Type> & { readonly lost: readonly MeetingSetupLoss[] } {
  const keysShown = new Map(
    shown.extensions.map((extension) => [folded(extension.before.name), extensionKeys(extension)]),
  );
  const extensions = now.extensions.flatMap((extension) => {
    const keys = keysShown.get(folded(extension.before.name));
    const within = keys === undefined ? null : extensionWithin(extension, keys);
    return within === null ? [] : [within];
  });
  return {
    rule: shown.rule === null ? null : now.rule,
    prompt: shown.prompt === null ? null : now.prompt,
    extensions,
    asksEmails: shown.asksEmails && now.asksEmails,
    ruleOn: now.ruleOn,
    lines: now.lines,
    lost: lostSince(shown, now),
  };
}

/**
 * What the preview said would be written that the vault now stands in the way
 * of — a file at the rule's path, a type now claimed twice — with the reason
 * as the vault says it now. What is merely there already is not lost. The
 * addresses are the caller's to judge, since only it knows what was typed.
 */
function lostSince(shown: MeetingSetupPlan, now: MeetingSetupPlan): MeetingSetupLoss[] {
  const nowByWhat = new Map(now.lines.map((line) => [line.what, line]));
  return shown.lines.flatMap((line) => {
    const later = nowByWhat.get(line.what);
    if (!line.written || line.kind === 'emails' || later === undefined) return [];
    return !later.written && later.blocked ? [{ what: line.what, reason: later.detail }] : [];
  });
}

/** Why typed addresses the preview asked for cannot be saved now, or null when they can. */
export function emailsLostSince(now: MeetingSetupPlan): string | null {
  if (now.asksEmails) return null;
  const line = now.lines.find((one) => one.kind === 'emails');
  return `Not saved. ${line?.detail ?? ''} Change them in Settings → Profile.`.replace(/ +/g, ' ');
}
