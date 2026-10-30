import {
  automationIdKey,
  describeAction,
  describePlan,
  describeSchedule,
  lastRunOf,
  logEntryHeading,
  logEntrySummary,
  capFor,
  MAX_LOG_ENTRIES,
  keepsCalendarClock,
  nextRunOf,
  noteTitle,
  ruleClockOf,
  printSchedule,
  type AutomationAction,
  type AutomationPlan,
  type LogEntry,
  type Schedule,
  type PassedOver,
  type SetValue,
  truncated,
} from '@dfai/domain';
import {
  loadAutomations,
  planRuleNow,
  withMeetingsNotLinked,
  withPeriodNote,
  type LoadedAutomation,
} from '../automations/index.ts';
import { planNowOf } from '../automations/rule-clock.ts';
import { readPlanZone } from '../settings/plan-zone.ts';
import { AtlasQueryError } from '../query/run-atlas-query.ts';
import { loadObjectTypes } from '../types/load-types.ts';
import { listVaultNotes } from '../vault/read-vault.ts';
import { ApiError, messageWithoutPaths } from './api-error.ts';
import type {
  ApiAutomation,
  ApiAutomationLastRun,
  ApiAutomationList,
  ApiAutomationLog,
  ApiAutomationLogEntry,
  ApiAutomationPlan,
  ApiAutomationRef,
  ApiClaudeStep,
  ApiNoteTrigger,
} from './contract.ts';
import { countOf } from './fields.ts';
import { decodeSegment } from './paths.ts';
import type { RouteResult, VaultRequest } from './vault-request.ts';

/*
 * Automations (P25), read-only. Rules and their logs live in `.atlas`, which
 * the API never writes, and a run or an undo changes many notes at once — so
 * running, undoing, and making or editing a rule stay in the app (ADR-0016).
 * What is here is what the Automations page shows, and its dry run.
 */

const LOG_LIMIT = { fallback: 20, max: MAX_LOG_ENTRIES };
/** The most notes passed over a dry run lists; the rest are counted. A run's own cap does not bound them. */
const PASSED_OVER_LISTED = 500;
/** How much of an unknown id a refusal repeats back. */
const ECHOED_ID_LENGTH = 80;

/** Every rule in the vault, as the Automations page lists it; broken ones apart, with why. */
export async function automationsRoute(request: VaultRequest): Promise<RouteResult> {
  const listing = await listingOf(request);
  const planZone = await readPlanZone(request);
  const clock = {
    now: request.clock.localNow(),
    planZone,
    planNow: planNowOf(request.clock, planZone),
  };
  const automations = listing.automations.map((loaded) => automationOf(loaded, request, clock));
  request.assertStillOpen();
  const body: ApiAutomationList = {
    automations,
    broken: listing.broken.map(({ path, name, problem }) => ({ path, name, problem })),
  };
  return { status: 200, body };
}

/** A rule's log, newest first, as far back as `limit`. */
export async function automationLogRoute(request: VaultRequest): Promise<RouteResult> {
  const limit = countOf(request.query['limit'], { field: 'limit', ...LOG_LIMIT });
  const { rule, log } = await namedAutomation(request);
  request.assertStillOpen();
  const newest = [...log].reverse();
  const body: ApiAutomationLog = {
    automation: refOf(rule),
    entries: newest.slice(0, limit).map((entry) => logEntryOf(withoutPaths(entry))),
    truncated: newest.length > limit,
  };
  return { status: 200, body };
}

/**
 * What a rule would do if it ran now: the plan a run would carry out, from
 * the same use-case, and nothing written — for a rule a note sets off, the
 * notes it has not handled as they are now, which a run by hand would take.
 * A rule whose query does not read is `query_failed`, with why.
 */
export async function automationDryRunRoute(request: VaultRequest): Promise<RouteResult> {
  const { rule, log, ledger } = await namedAutomation(request);
  const [types, notePaths] = await Promise.all([
    loadObjectTypes({ fs: request.fs, markdown: request.markdown }),
    listVaultNotes({ fs: request.fs }),
  ]);
  const ports = {
    index: request.index,
    types,
    notePaths,
    fs: request.fs,
    markdown: request.markdown,
  };
  const target = await planRuleNow({
    ports,
    rule,
    log,
    ledger,
    today: request.clock.today(),
  }).catch((error: unknown) => {
    if (!(error instanceof AtlasQueryError)) throw error;
    throw new ApiError(
      'query_failed',
      `This automation’s query could not run: ${messageWithoutPaths(error)}`,
    );
  });
  const planned = await withPeriodNote({
    plan: target.plan,
    rule,
    log,
    at: request.clock.localNow(),
    ports,
  });
  const plan = await withMeetingsNotLinked({
    plan: planned,
    rule,
    ports,
    today: request.clock.today(),
  });
  // The index answers for the vault open now: a plan read after a switch would be the other vault's notes.
  request.assertStillOpen();
  return { status: 200, body: { automation: refOf(rule), plan: planOf(plan) } };
}

async function listingOf(request: VaultRequest) {
  const notePaths = await listVaultNotes({ fs: request.fs });
  return loadAutomations({ fs: request.fs, markdown: request.markdown, notePaths });
}

/**
 * The rule the URL's `{id}` names, found as the app finds it — whatever its
 * case or Unicode form, since ids name log files on a disk that may ignore
 * both (`automationIdKey`). A rule whose
 * file cannot be read has no id to trust, so it is found by its name or its
 * file's, and refused with why.
 */
async function namedAutomation(request: VaultRequest): Promise<LoadedAutomation> {
  const id = decodeSegment(request.idParam, 'id');
  const listing = await listingOf(request);
  const key = automationIdKey(id);
  const found = listing.automations.find(({ rule }) => automationIdKey(rule.id) === key);
  if (found !== undefined) return found;
  const broken = listing.broken.find(
    ({ path, name }) => automationIdKey(name) === key || automationIdKey(stemOf(path)) === key,
  );
  if (broken !== undefined) {
    throw new ApiError(
      'invalid',
      `The automation “${broken.name}” cannot be read, so it has no log or dry run: ${broken.problem}`,
    );
  }
  throw new ApiError('not_found', `No automation has id ${JSON.stringify(echoOf(id))}`);
}

/** An id as a refusal repeats it: cut short, so a caller cannot make the answer as long as it likes. */
function echoOf(id: string): string {
  const characters = [...id];
  if (characters.length <= ECHOED_ID_LENGTH) return id;
  return `${characters.slice(0, ECHOED_ID_LENGTH).join('')}…`;
}

const stemOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');

const refOf = (rule: { id: string; name: string }): ApiAutomationRef => ({
  id: rule.id,
  name: rule.name,
});

/** The action as the rule's file writes it: `do`, `set` for a set rule, and a Claude step's keys. */
function actionFields(action: AutomationAction): {
  do: AutomationAction['kind'];
  set: Readonly<Record<string, SetValue>> | null;
  claude: ApiClaudeStep | null;
} {
  return {
    do: action.kind,
    set: action.kind === 'set' ? { ...action.values } : null,
    claude: action.kind === 'claude' ? claudeStepOf(action) : null,
  };
}

function claudeStepOf(action: Extract<AutomationAction, { kind: 'claude' }>): ApiClaudeStep {
  const { output } = action;
  return {
    prompt: action.prompt,
    tools: [...action.tools],
    output: output.kind === 'note' ? 'note' : output.schema,
    folder: output.kind === 'note' ? output.folder : null,
    data: action.data ?? null,
  };
}

/**
 * A rule as the page's row reads it. Its next run is counted as the app's
 * clock counts it — from when the app began watching the vault, for a rule
 * never run — and a rule paused until run by hand has none.
 */
function automationOf(
  { rule, log }: LoadedAutomation,
  request: VaultRequest,
  clock: { now: string; planZone: string | null; planNow: string | null },
): ApiAutomation {
  const pause = request.automationClock?.pauses.get(rule.id) ?? null;
  // The morning brief is counted on the plan zone's clock, as the app's runner counts it (#587).
  const { now, watchingSince } = ruleClockOf({
    rule,
    now: clock.now,
    watchingSince: request.automationClock?.watchingSince ?? clock.now,
    planNow: clock.planNow,
  });
  const nextRun = pause?.retryAt === null ? null : nextRunOf({ rule, log, watchingSince, now });
  return {
    id: rule.id,
    name: rule.name,
    path: rule.path,
    enabled: rule.enabled,
    when: printSchedule(rule.when),
    note: noteTriggerOf(rule.when),
    which: rule.which,
    olderThanDays: rule.olderThanDays,
    ...actionFields(rule.action),
    schedule: describeSchedule(rule.when),
    action: describeAction(rule.action),
    lastRun: lastRunFrom(log),
    nextRun,
    timeZone: clock.planZone !== null && keepsCalendarClock(rule) ? clock.planZone : null,
    // A pause's reason can quote the disk's refusal, path and all.
    paused: pause === null ? null : messageWithoutPaths(pause.reason),
  };
}

function noteTriggerOf(when: Schedule): ApiNoteTrigger | null {
  return when.kind === 'note' ? { type: when.type, on: [...when.on] } : null;
}

function lastRunFrom(log: readonly LogEntry[]): ApiAutomationLastRun | null {
  const last = lastRunOf(log);
  if (last === null) return null;
  const summary = logEntrySummary(withoutPaths(last));
  return { at: last.at, kind: last.kind, trigger: last.trigger, summary };
}

/**
 * A log entry with this machine's paths taken out of every reason. The runner
 * strips them as it writes, but logs written before it did still hold them.
 */
function withoutPaths(entry: LogEntry): LogEntry {
  switch (entry.kind) {
    case 'failed':
      return { ...entry, problem: messageWithoutPaths(entry.problem) };
    case 'run':
    case 'undo':
      return { ...entry, left: entry.left.map(leftWithoutPaths) };
    case 'turnedOn':
    case 'seen':
    case 'letGo':
      return entry;
  }
}

const leftWithoutPaths = ({ path, reason }: PassedOver): PassedOver => ({
  path,
  reason: messageWithoutPaths(reason),
});

function logEntryOf(entry: LogEntry): ApiAutomationLogEntry {
  const words = { at: entry.at, heading: logEntryHeading(entry), summary: logEntrySummary(entry) };
  switch (entry.kind) {
    case 'run':
      return {
        kind: 'run',
        ...words,
        trigger: entry.trigger,
        capped: entry.capped,
        done: entry.done,
        left: entry.left,
        ...(entry.versions !== undefined && { versions: entry.versions }),
        ...(entry.went !== undefined && { went: entry.went }),
        ...(entry.claude !== undefined && { claude: entry.claude }),
      };
    case 'undo':
      return { kind: 'undo', ...words, of: entry.of, done: entry.done, left: entry.left };
    case 'failed':
      return {
        kind: 'failed',
        ...words,
        trigger: entry.trigger,
        problem: truncated(entry.problem),
        ...(entry.claude !== undefined && { claude: entry.claude }),
        // A Claude step cut off part-way left what it had made.
        done: entry.done ?? [],
        left: [],
      };
    case 'turnedOn':
    case 'seen':
      return { kind: entry.kind, ...words, done: [], left: [] };
    case 'letGo':
      return { kind: 'letGo', ...words, count: entry.count, done: [], left: [] };
  }
}

function planOf(plan: AutomationPlan): ApiAutomationPlan {
  return {
    ...actionFields(plan.action),
    summary: describePlan(plan),
    notes: plan.paths.map((path) => ({ path, title: noteTitle(path) })),
    passedOver: plan.passedOver
      .slice(0, PASSED_OVER_LISTED)
      .map(({ path, reason }) => ({ path, reason })),
    passedOverMore: Math.max(0, plan.passedOver.length - PASSED_OVER_LISTED),
    capped: plan.capped,
    cap: capFor(plan.action),
    ...(plan.notLinked !== undefined && {
      notLinked: {
        meetings: plan.notLinked.paths.map((path) => ({ path, title: noteTitle(path) })),
        capped: plan.notLinked.capped,
      },
    }),
  };
}
