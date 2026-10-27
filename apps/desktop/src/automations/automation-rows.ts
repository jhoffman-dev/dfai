import {
  describeAction,
  describePlan,
  describeSchedule,
  futureMarkOf,
  keepsCalendarClock,
  lastRunOf,
  lastUndoableRun,
  logEntryHeading,
  logEntrySummary,
  nextRunOf,
  ruleClockOf,
  noteTitle,
  type AutomationPlan,
  type DoneAction,
  type LocalTime,
  type LogEntry,
  type PriorValue,
  type VaultPath,
} from '@dfai/domain';
import type { AutomationListing, LoadedAutomation } from '@dfai/application';
import type { AutomationRow, DryRunView, LogEntryView, LogLineView } from '@dfai/ui';
import type { RulePause } from './use-automations.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A wall-clock time as the page shows it: `27 Sep 2026, 03:00`. */
export function shownTime(time: LocalTime, { seconds = false } = {}): string {
  const [date = '', clock = ''] = time.split('T');
  const [year, month, day] = date.split('-');
  const hhmm = seconds ? clock : clock.slice(0, 5);
  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? month} ${year}, ${hhmm}`;
}

/** What a row is read against: when watching began, the time now, and the rules the clock has paused. */
export interface RowClock {
  readonly watchingSince: LocalTime;
  readonly now: LocalTime;
  readonly pauses: ReadonlyMap<string, RulePause>;
  /** The plan zone's wall clock now, which the morning brief is counted on; null when none is kept (#587). */
  readonly planNow?: LocalTime | null;
  /** What says a time is on the plan zone's clock, `Chicago time`; null when it is the Mac's (#587). */
  readonly planClock?: string | null;
}

/** Every rule as its row: broken ones too, with why. */
export function automationRows(listing: AutomationListing, clock: RowClock): AutomationRow[] {
  const rows = listing.automations.map((loaded) => rowOf(loaded, clock));
  const broken = listing.broken.map((rule): AutomationRow => ({
    id: rule.path,
    name: rule.name,
    enabled: false,
    schedule: '',
    action: '',
    lastRun: null,
    nextRun: null,
    canUndo: false,
    problem: `This rule’s file cannot be read: ${rule.problem}`,
    notice: null,
  }));
  return [...rows, ...broken];
}

function rowOf({ rule, log }: LoadedAutomation, clock: RowClock): AutomationRow {
  const { watchingSince, now } = ruleClockOf({ rule, ...clock, planNow: clock.planNow ?? null });
  const last = lastRunOf(log);
  const pause = clock.pauses.get(rule.id);
  const next = pause?.retryAt === null ? null : nextRunOf({ rule, log, watchingSince, now });
  return {
    id: rule.path,
    name: rule.name,
    enabled: rule.enabled,
    schedule: describeSchedule(rule.when),
    action: describeAction(rule.action),
    lastRun: last === null ? null : `${shownTime(last.at)} · ${logEntrySummary(last)}`,
    nextRun: next === null ? null : withClock(shownTime(next), rule, clock),
    canUndo: lastUndoableRun(log) !== null,
    problem: null,
    notice: pause?.reason ?? futureNotice(log, now),
  };
}

/** A time the brief is counted on, with the clock it is on when that is not the Mac's: `07:00 Chicago time`. */
function withClock(time: string, rule: LoadedAutomation['rule'], clock: RowClock): string {
  const label = clock.planClock ?? null;
  return label === null || (clock.planNow ?? null) === null || !keepsCalendarClock(rule)
    ? time
    : `${time} ${label}`;
}

/** What the row says of a mark later than now, which the schedule does not count from. */
function futureNotice(log: readonly LogEntry[], now: LocalTime): string | null {
  const ahead = futureMarkOf(log, now);
  return ahead === null
    ? null
    : `Its log has an entry dated ${shownTime(ahead)}, later than now; its schedule counts from before it.`;
}

/** A rule's log as the page lists it: newest first. */
export function logViews(log: readonly LogEntry[]): LogEntryView[] {
  return log
    .map((entry, at): LogEntryView => ({
      id: `${at}:${entry.at}`,
      heading: `${shownTime(entry.at, { seconds: true })} · ${logEntryHeading(entry)}`,
      summary: logEntrySummary(entry),
      lines: [
        ...('done' in entry ? entry.done.map(doneLine) : []),
        ...('left' in entry
          ? entry.left.map((left): LogLineView => ({
              kind: 'left',
              text: `Left ${noteTitle(left.path)}: ${left.reason}`,
            }))
          : []),
      ],
    }))
    .reverse();
}

const valueText = (value: PriorValue): string =>
  'absent' in value ? 'nothing' : JSON.stringify(value.value);

function doneLine(action: DoneAction): LogLineView {
  switch (action.kind) {
    case 'archived':
      return { kind: 'done', text: `Archived ${noteTitle(action.from)} (${action.from})` };
    case 'unarchived':
      return { kind: 'done', text: `Put back ${noteTitle(action.to)} (${action.to})` };
    case 'set':
    case 'restored': {
      const verb = action.kind === 'set' ? 'Set' : 'Restored';
      const change = `${valueText(action.before)} → ${valueText(action.after)}`;
      return {
        kind: 'done',
        text: `${verb} ${action.key} on ${noteTitle(action.path)}: ${change}`,
      };
    }
    case 'proposed':
      return { kind: 'done', text: `Proposed ${noteTitle(action.path)} (${action.path})` };
    case 'created':
      return { kind: 'done', text: `Made ${noteTitle(action.path)} (${action.path})` };
    case 'summarised':
      return { kind: 'done', text: `Wrote the summary at the top of ${noteTitle(action.path)}` };
    case 'trashed':
      return { kind: 'done', text: `Trashed ${noteTitle(action.path)} (${action.path})` };
    case 'unsummarised':
      return { kind: 'done', text: `Took the summary off ${noteTitle(action.path)}` };
  }
}

/** A dry run's plan as the page shows it. */
export function dryRunView(plan: AutomationPlan): DryRunView {
  return {
    kind: 'plan',
    summary: describePlan(plan),
    notes: plan.paths.map((path: VaultPath) => ({ path, title: noteTitle(path) })),
    passedOver: plan.passedOver.map(({ path, reason }) => ({ title: noteTitle(path), reason })),
  };
}
