import { useState, type ReactNode } from 'react';
import {
  CLAUDE_DATA,
  claudeStepDefaultModel,
  outputHasItems,
  withClaudeChoices,
  withClaudeData,
  withClaudeSkill,
  type AutomationAction,
  type AutomationDraft,
  type ClaudeAction,
  type ClaudeData,
  type NoteEvent,
  type Schedule,
  type SkillRunProblem,
  type Weekday,
} from '@dfai/domain';
import { SegmentedControl } from '../segmented-control.tsx';
import { Toggle } from '../toggle.tsx';
import type { DryRunView, LogEntryView } from './automation-views.ts';
import { DryRunResult, RunLog } from './run-log-view.tsx';

/** A skill the picker offers, and why a run could not ask with it, if it could not (#169). */
export interface SkillChoice {
  readonly name: string;
  readonly unusable: SkillRunProblem['kind'] | null;
}

export interface AutomationEditorProps {
  readonly draft: AutomationDraft;
  readonly onChange: (draft: AutomationDraft) => void;
  /** A rule not yet written: saving creates its file. */
  readonly isNew: boolean;
  /** Why the draft cannot be saved yet, or null. */
  readonly problem: string | null;
  /** Where "which notes" is edited: the query builder, as the query page has it. */
  readonly which: ReactNode;
  /** The vault's types, by name: what a note trigger can watch for. */
  readonly typeNames: readonly string[];
  /**
   * Whether "Ask Claude" is offered as what a rule does: not where there is
   * no Claude Code (#657). A rule that already asks Claude still shows so.
   */
  readonly offersClaude: boolean;
  /** The read tools a Claude step may be given (P29-03). */
  readonly claudeTools: readonly string[];
  /** The proposal schemas a Claude step can answer with, by name: `proposals` first. */
  readonly claudeOutputs: readonly string[];
  /** The vault's skills: what a Claude step may ask with in place of a prompt (#169). */
  readonly skills: readonly SkillChoice[];
  readonly busy: boolean;
  readonly onSave: () => void;
  readonly onCancel: () => void;
  readonly onDryRun: () => void;
  readonly onRunNow: () => void;
  readonly onUndo: () => void;
  readonly canUndo: boolean;
  readonly dryRun: DryRunView | null;
  readonly log: readonly LogEntryView[];
  readonly onOpenNote: (path: string) => void;
}

type ScheduleKind = Schedule['kind'];

const SCHEDULES = [
  { value: 'daily' as const, label: 'Daily' },
  { value: 'weekly' as const, label: 'Weekly' },
  { value: 'hourly' as const, label: 'Every few hours' },
  { value: 'open' as const, label: 'When DFAI opens' },
  { value: 'manual' as const, label: 'By hand' },
  { value: 'note' as const, label: 'When a note appears' },
];

/** The days a weekly rule may run on, Monday first, as a person reads a week. */
const DAYS: readonly { value: Weekday; label: string }[] = [
  { value: 'monday', label: 'Monday' },
  { value: 'tuesday', label: 'Tuesday' },
  { value: 'wednesday', label: 'Wednesday' },
  { value: 'thursday', label: 'Thursday' },
  { value: 'friday', label: 'Friday' },
  { value: 'saturday', label: 'Saturday' },
  { value: 'sunday', label: 'Sunday' },
];

/** What DFAI may hand a Claude step beside its notes, as the editor offers it. */
const DATA_LABELS: Readonly<Record<ClaudeData, string>> = {
  'weekly-review': 'The weekly review',
  'meeting-briefs': 'Each of today’s meetings, briefed',
};

const NOTE_EVENTS: readonly { value: NoteEvent; label: string }[] = [
  { value: 'created', label: 'is created' },
  { value: 'changed', label: 'is changed' },
];

const ACTIONS = [
  { value: 'archive' as const, label: 'Archive' },
  { value: 'set' as const, label: 'Set a property' },
  { value: 'claude' as const, label: 'Ask Claude' },
];

/** What a Claude step writes, as the editor offers it: a schema's proposals, or one new note. */
const NOTE_OUTPUT = 'note';
const OUTPUT_LABELS: Readonly<Record<string, string>> = {
  proposals: 'Proposals in the Inbox',
  'meeting-items': 'A meeting’s actions and decisions, as proposals',
  'meeting-digest': 'A summary at the top of the meeting, with its actions and decisions',
  [NOTE_OUTPUT]: 'One new note',
};

/**
 * What a schedule becomes when its kind is picked: the time or gap it had, or
 * a start — for a note trigger, a note of `type` being created.
 */
function scheduleOf(kind: ScheduleKind, was: Schedule, type: string): Schedule {
  if (kind === was.kind) return was;
  if (kind === 'daily') return { kind, at: '03:00' };
  if (kind === 'weekly') return { kind, day: 'friday', at: '15:00' };
  if (kind === 'hourly') return { kind, every: 6 };
  if (kind === 'note') return { kind, type, on: ['created'] };
  return { kind };
}

/** The events picked once one is turned on or off, in their order; the last one stays on. */
function eventsWith(on: readonly NoteEvent[], event: NoteEvent, picked: boolean): NoteEvent[] {
  const next = NOTE_EVENTS.map((each) => each.value).filter((each) =>
    each === event ? picked : on.includes(each),
  );
  return next.length === 0 ? [...on] : next;
}

/**
 * One automation, being made or changed (P25-03): its name, when it runs,
 * which notes — the query builder — and what it does to them; then a dry run,
 * running it now, undoing its last run, and its log.
 */
export function AutomationEditor(props: AutomationEditorProps) {
  const { draft, onChange } = props;
  return (
    <section className="automation-editor" aria-label="Automation">
      <div className="automation-editor__form">
        <label className="automation-editor__field">
          <span className="automation-editor__label">Name</span>
          <input
            className="field"
            value={draft.name}
            placeholder="Archive done tasks after 30 days"
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </label>
        <div className="automation-editor__field">
          <span className="automation-editor__label">On</span>
          <Toggle
            label="Run this automation on its schedule"
            checked={draft.enabled}
            onChange={(enabled) => onChange({ ...draft, enabled })}
          />
        </div>
        <ScheduleField draft={draft} onChange={onChange} typeNames={props.typeNames} />
        <div className="automation-editor__field automation-editor__field--wide">
          <span className="automation-editor__label">Which notes</span>
          {props.which}
          {/* The note that sets a rule off has just changed: an age filter would leave it out. */}
          {draft.when.kind !== 'note' && <AgeField draft={draft} onChange={onChange} />}
        </div>
        <ActionField
          draft={draft}
          onChange={onChange}
          offersClaude={props.offersClaude}
          claudeTools={props.claudeTools}
          claudeOutputs={props.claudeOutputs}
          skills={props.skills}
        />
      </div>
      {props.problem !== null && (
        <p className="automation-editor__problem" role="alert">
          {props.problem}
        </p>
      )}
      <EditorButtons {...props} />
      {props.dryRun !== null && (
        <DryRunResult result={props.dryRun} onOpenNote={props.onOpenNote} />
      )}
      {!props.isNew && <RunLog entries={props.log} />}
    </section>
  );
}

function ScheduleField({
  draft,
  onChange,
  typeNames,
}: Pick<AutomationEditorProps, 'draft' | 'onChange' | 'typeNames'>) {
  const { when } = draft;
  return (
    <div className="automation-editor__field automation-editor__field--wide">
      <span className="automation-editor__label">When</span>
      <div className="automation-editor__row">
        <SegmentedControl
          label="When it runs"
          options={SCHEDULES}
          value={when.kind}
          onChange={(kind) =>
            onChange({
              ...draft,
              when: scheduleOf(kind, when, typeNames[0] ?? ''),
              ...(kind === 'note' && { olderThanDays: null }),
            })
          }
        />
        {when.kind === 'daily' && (
          <input
            type="time"
            className="field automation-editor__small"
            aria-label="Time of day"
            value={when.at}
            onChange={(event) =>
              event.target.value !== '' &&
              onChange({ ...draft, when: { kind: 'daily', at: event.target.value.slice(0, 5) } })
            }
          />
        )}
        {when.kind === 'weekly' && (
          <>
            <select
              className="field automation-editor__small"
              aria-label="Day of the week"
              value={when.day}
              onChange={(event) =>
                onChange({ ...draft, when: { ...when, day: event.target.value as Weekday } })
              }
            >
              {DAYS.map((day) => (
                <option key={day.value} value={day.value}>
                  {day.label}
                </option>
              ))}
            </select>
            <input
              type="time"
              className="field automation-editor__small"
              aria-label="Time of day"
              value={when.at}
              onChange={(event) =>
                event.target.value !== '' &&
                onChange({ ...draft, when: { ...when, at: event.target.value.slice(0, 5) } })
              }
            />
          </>
        )}
        {when.kind === 'hourly' && (
          <label className="automation-editor__inline">
            every
            <input
              type="number"
              min={1}
              max={168}
              className="field automation-editor__small"
              aria-label="Hours between runs"
              value={when.every}
              onChange={(event) =>
                onChange({ ...draft, when: { kind: 'hourly', every: Number(event.target.value) } })
              }
            />
            hours
          </label>
        )}
        {when.kind === 'note' && (
          <NoteTriggerFields draft={draft} onChange={onChange} typeNames={typeNames} />
        )}
      </div>
    </div>
  );
}

/** A note trigger's type, and whether a note being created, changed or both sets it off. */
function NoteTriggerFields({
  draft,
  onChange,
  typeNames,
}: Pick<AutomationEditorProps, 'draft' | 'onChange' | 'typeNames'>) {
  const { when } = draft;
  if (when.kind !== 'note') return null;
  // A type the file names that the vault lacks is still shown, so the select says what the rule says.
  const names = typeNames.includes(when.type) ? typeNames : [when.type, ...typeNames];
  return (
    <span className="automation-editor__inline">
      a
      <select
        className="field automation-editor__small"
        aria-label="Type of note"
        value={when.type}
        onChange={(event) => onChange({ ...draft, when: { ...when, type: event.target.value } })}
      >
        {names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      {NOTE_EVENTS.map(({ value, label }) => (
        <label key={value} className="automation-editor__inline">
          <input
            type="checkbox"
            className="select-box"
            checked={when.on.includes(value)}
            onChange={(event) =>
              onChange({
                ...draft,
                when: { ...when, on: eventsWith(when.on, value, event.target.checked) },
              })
            }
          />
          {label}
        </label>
      ))}
    </span>
  );
}

function AgeField({ draft, onChange }: Pick<AutomationEditorProps, 'draft' | 'onChange'>) {
  const on = draft.olderThanDays !== null;
  return (
    <label className="automation-editor__inline automation-editor__age">
      <input
        type="checkbox"
        className="select-box"
        checked={on}
        onChange={() => onChange({ ...draft, olderThanDays: on ? null : 30 })}
      />
      Only notes not changed in the last
      <input
        type="number"
        min={1}
        className="field automation-editor__small"
        aria-label="Days unchanged"
        disabled={!on}
        value={draft.olderThanDays ?? 30}
        onChange={(event) => onChange({ ...draft, olderThanDays: Number(event.target.value) })}
      />
      days
    </label>
  );
}

type ActionProps = Pick<
  AutomationEditorProps,
  'draft' | 'onChange' | 'offersClaude' | 'claudeTools' | 'claudeOutputs' | 'skills'
>;

/** The actions offered: Claude's only where it is, or where the rule already asks it. */
const WITHOUT_CLAUDE = ACTIONS.filter((each) => each.value !== 'claude');

/** What picking an action starts from: a Claude step reads the note with the first schema. */
function actionOf(kind: AutomationAction['kind'], outputs: readonly string[]): AutomationAction {
  if (kind === 'archive') return { kind };
  if (kind === 'set') return { kind, values: { status: '' } };
  return {
    kind,
    prompt: '',
    tools: ['atlas_read_note'],
    output: { kind: 'proposals', schema: outputs[0] ?? 'proposals' },
  };
}

function ActionField({
  draft,
  onChange,
  offersClaude,
  claudeTools,
  claudeOutputs,
  skills,
}: ActionProps) {
  const { action } = draft;
  // What the rule did as it was opened: a Claude step it had can always be
  // chosen again, as it was, so a misclick away is never saved for good (#657).
  const [loaded] = useState(action);
  const asksClaude = offersClaude || loaded.kind === 'claude' || action.kind === 'claude';
  const [key = '', value = ''] =
    action.kind === 'set' ? (Object.entries(action.values)[0] ?? []) : [];
  const setTo = (nextKey: string, nextValue: string): AutomationAction => ({
    kind: 'set',
    values: nextKey === '' && nextValue === '' ? {} : { [nextKey]: nextValue },
  });
  return (
    <div className="automation-editor__field automation-editor__field--wide">
      <span className="automation-editor__label">Do</span>
      <div className="automation-editor__row">
        <SegmentedControl
          label="What it does"
          options={asksClaude ? ACTIONS : WITHOUT_CLAUDE}
          value={action.kind}
          onChange={(kind) =>
            onChange({
              ...draft,
              action:
                kind === 'claude' && loaded.kind === 'claude'
                  ? loaded
                  : actionOf(kind, claudeOutputs),
            })
          }
        />
        {action.kind === 'set' && (
          <>
            <input
              className="field automation-editor__small"
              aria-label="Property"
              placeholder="status"
              value={key}
              onChange={(event) =>
                onChange({ ...draft, action: setTo(event.target.value, String(value)) })
              }
            />
            <span className="automation-editor__to">to</span>
            <input
              className="field automation-editor__small"
              aria-label="Value"
              placeholder="done"
              value={String(value)}
              onChange={(event) => onChange({ ...draft, action: setTo(key, event.target.value) })}
            />
          </>
        )}
      </div>
      {action.kind === 'claude' && (
        <ClaudeFields
          draft={draft}
          onChange={onChange}
          claudeTools={claudeTools}
          claudeOutputs={claudeOutputs}
          skills={skills}
        />
      )}
    </div>
  );
}

/** A Claude step's prompt or skill, what it writes, and the read tools it may call. */
function ClaudeFields({
  draft,
  onChange,
  claudeTools,
  claudeOutputs,
  skills,
}: Omit<ActionProps, 'offersClaude'>) {
  const { action } = draft;
  if (action.kind !== 'claude') return null;
  const change = (next: Partial<typeof action>) =>
    onChange({ ...draft, action: { ...action, ...next } });
  const output = action.output.kind === 'note' ? NOTE_OUTPUT : action.output.schema;
  return (
    <div className="automation-editor__claude">
      <SkillPicker
        action={action}
        skills={skills}
        onChange={(next) => onChange({ ...draft, action: next })}
      />
      {action.skill === undefined && (
        <label className="automation-editor__inline">
          Prompt
          <input
            className="field"
            aria-label="Prompt"
            placeholder=".atlas/prompts/meeting-actions.md"
            value={action.prompt}
            onChange={(event) => change({ prompt: event.target.value })}
          />
        </label>
      )}
      <label className="automation-editor__inline">
        Writes
        <select
          className="field automation-editor__small"
          aria-label="What Claude writes"
          value={output}
          onChange={(event) => {
            const toNote = event.target.value === NOTE_OUTPUT;
            const next = {
              ...action,
              output: toNote
                ? ({ kind: 'note', folder: '' } as const)
                : ({ kind: 'proposals', schema: event.target.value } as const),
            };
            // The data is for a note only; its control goes with the note output, so it must not stay hidden.
            onChange({ ...draft, action: toNote ? next : withClaudeData(next, null) });
          }}
        >
          {[...claudeOutputs, NOTE_OUTPUT].map((name) => (
            <option key={name} value={name}>
              {OUTPUT_LABELS[name] ?? name}
            </option>
          ))}
        </select>
      </label>
      {action.output.kind === 'note' && (
        <label className="automation-editor__inline">
          in
          <input
            className="field automation-editor__small"
            aria-label="Folder"
            placeholder="Briefs"
            value={action.output.folder}
            onChange={(event) => change({ output: { kind: 'note', folder: event.target.value } })}
          />
        </label>
      )}
      {action.output.kind === 'note' && (
        <label className="automation-editor__inline">
          given
          <select
            className="field automation-editor__small"
            aria-label="What DFAI hands Claude"
            value={action.data ?? ''}
            onChange={(event) => {
              const data = CLAUDE_DATA.find((each) => each === event.target.value) ?? null;
              onChange({ ...draft, action: withClaudeData(action, data) });
            }}
          >
            <option value="">Only its notes</option>
            {CLAUDE_DATA.map((data) => (
              <option key={data} value={data}>
                {DATA_LABELS[data]}
              </option>
            ))}
          </select>
        </label>
      )}
      <ClaudeChoices action={action} onChange={(next) => onChange({ ...draft, action: next })} />
      <fieldset className="automation-editor__tools">
        <legend>Tools Claude may use</legend>
        {claudeTools.map((tool) => (
          <label key={tool} className="automation-editor__inline">
            <input
              type="checkbox"
              className="select-box"
              checked={action.tools.includes(tool)}
              onChange={(event) =>
                change({
                  tools: event.target.checked
                    ? [...action.tools, tool]
                    : action.tools.filter((each) => each !== tool),
                })
              }
            />
            {tool}
          </label>
        ))}
      </fieldset>
    </div>
  );
}

/** How the picker marks a skill a run could not ask with, so it is not picked unknowing. */
const UNUSABLE_LABELS: Readonly<Record<SkillRunProblem['kind'], string>> = {
  problems: 'has problems',
  'too-long': 'too long to run',
};

/** Ask with a prompt note, or one of the vault's skills (#169); a skill gone from the vault stays shown. */
function SkillPicker({
  action,
  skills,
  onChange,
}: {
  action: ClaudeAction;
  skills: readonly SkillChoice[];
  onChange: (action: ClaudeAction) => void;
}) {
  const named = action.skill;
  // The prompt note the step had before a skill was picked: given back if the skill is let go.
  const [before, setBefore] = useState('');
  const listed = named === undefined || skills.some((skill) => skill.name === named);
  const offered = listed ? skills : [{ name: named, unusable: null }, ...skills];
  return (
    <label className="automation-editor__inline">
      Asks with
      <select
        className="field automation-editor__small"
        aria-label="Skill"
        value={named ?? ''}
        onChange={(event) => {
          const picked = event.target.value === '' ? null : event.target.value;
          if (picked !== null && named === undefined) setBefore(action.prompt);
          onChange(withClaudeSkill(action, picked, before));
        }}
      >
        <option value="">A prompt note</option>
        {offered.map(({ name, unusable }) => (
          <option key={name} value={name}>
            {`Skill: ${name}${unusable === null ? '' : ` (${UNUSABLE_LABELS[unusable]})`}`}
          </option>
        ))}
      </select>
    </label>
  );
}

const APPLIES = [
  { value: '', label: 'Nothing: every item is a proposal' },
  { value: 'mine', label: 'My own action items' },
] as const;

/**
 * What of a meeting's items becomes a task without a click (#179), offered
 * for an output that has items, or while the rule says it so it can be taken
 * out; and the model it asks, blank for its default.
 */
function ClaudeChoices({
  action,
  onChange,
}: {
  action: ClaudeAction;
  onChange: (action: ClaudeAction) => void;
}) {
  const apply = action.apply ?? null;
  const model = action.model ?? '';
  return (
    <>
      {(outputHasItems(action.output) || apply !== null) && (
        <label className="automation-editor__inline">
          Make into tasks
          <select
            className="field automation-editor__small"
            aria-label="What becomes a task"
            value={apply ?? ''}
            onChange={(event) =>
              onChange(
                withClaudeChoices(action, {
                  apply: event.target.value === 'mine' ? 'mine' : null,
                  model,
                }),
              )
            }
          >
            {APPLIES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="automation-editor__inline">
        Model
        <input
          className="field automation-editor__small"
          aria-label="Model"
          placeholder={claudeStepDefaultModel(action) ?? 'The chat’s model'}
          value={model}
          onChange={(event) =>
            onChange(withClaudeChoices(action, { apply, model: event.target.value }))
          }
        />
      </label>
    </>
  );
}

function EditorButtons(props: AutomationEditorProps) {
  const saveable = props.problem === null && !props.busy;
  return (
    <div className="automation-editor__buttons">
      <button
        type="button"
        className="btn btn--primary"
        disabled={!saveable}
        onClick={props.onSave}
      >
        {props.isNew ? 'Create automation' : 'Save'}
      </button>
      <button
        type="button"
        className="btn btn--secondary"
        disabled={props.busy}
        onClick={props.onDryRun}
      >
        Dry run
      </button>
      {!props.isNew && (
        <>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={props.busy}
            onClick={props.onRunNow}
          >
            Run now
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={props.busy || !props.canUndo}
            onClick={props.onUndo}
          >
            Undo last run
          </button>
        </>
      )}
      <button type="button" className="btn btn--ghost" onClick={props.onCancel}>
        {props.isNew ? 'Cancel' : 'Close'}
      </button>
    </div>
  );
}
