import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import type { SkillDraft, SkillField, SkillProblem } from '@dfai/domain';
import { Icon } from './icon.tsx';
import { PageAction, PageBar, type PageHistory } from './page-bar.tsx';
import { HiddenTitle } from './page-head.tsx';
import { SkillAsk, type SkillAskView } from './skill-ask.tsx';

/** A skill as the list shows it: what it says it does, and what is wrong with it, in the domain's words. */
export interface SkillListing {
  readonly name: string;
  readonly description: string;
  readonly problems: readonly string[];
  /** The automations that ask with it (#169), by name; none, or left out, when none does. */
  readonly usedBy?: readonly string[];
}

/** A prompt note in `.atlas/prompts`, listed beside the skills. */
export interface PromptListing {
  readonly name: string;
  readonly path: string;
}

/** A list read from the vault: null while it is read, or why it could not be. */
export interface ListedOr<T> {
  readonly items: readonly T[] | null;
  readonly error: string | null;
}

/** The skill being written or edited, with everything the domain said about it. */
export interface SkillEditorState {
  /** A new skill names itself; an existing one keeps its folder's name. */
  readonly mode: 'new' | 'edit';
  readonly draft: SkillDraft;
  /** What is wrong with the draft, each field's first problem: Save waits until there are none. */
  readonly problems: readonly SkillProblem[];
  /** What is wrong with SKILL.md as it was read, which saving the draft may put right. */
  readonly fileProblems: readonly string[];
  /** The description's length in characters, as the domain counts them, and its limit. */
  readonly descriptionLength: number;
  readonly descriptionLimit: number;
  /** Whether SKILL.md changed on disk under typing not yet saved. */
  readonly changedOnDisk: boolean;
  readonly saving: boolean;
  /** Whether Save may be pressed: no problem, no save under way, and the file as it was read. */
  readonly canSave: boolean;
  /** Whether the skill was made a moment ago: its editor takes the focus as it opens. */
  readonly justCreated: boolean;
  /** Why no save can write the skill as it was read, or null: said beside the Save that is off. */
  readonly saveRefusal: string | null;
  /** Whether a delete is under way: Delete is off until it answers. */
  readonly deleting: boolean;
}

/** The question before typing not saved is thrown away. */
export interface SkillDiscardQuestion {
  /** The skill being edited; null for a new one. */
  readonly name: string | null;
  readonly onKeep: () => void;
  readonly onDiscard: () => void;
}

/** Where the focus is sent once the editor it was in has gone: a skill's row, or the list. */
export type SkillFocus =
  { readonly kind: 'row'; readonly name: string } | { readonly kind: 'list' };

/** The question before a skill goes to the Trash, in the domain's words. */
export interface SkillDeleteQuestion {
  readonly warning: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export interface SkillsPageProps {
  readonly skills: ListedOr<SkillListing>;
  readonly prompts: ListedOr<PromptListing>;
  /** The skill open in the editor, by name; null when none is. */
  readonly selected: string | null;
  readonly editor: SkillEditorState | null;
  /** Why the last command failed, or null. */
  readonly notice: string | null;
  readonly deleteQuestion: SkillDeleteQuestion | null;
  readonly discardQuestion: SkillDiscardQuestion | null;
  /** Where to put the focus, once; `onFocused` says it was put there. */
  readonly focusTarget: SkillFocus | null;
  onFocused: () => void;
  onSelect: (name: string) => void;
  onNew: () => void;
  onChange: (change: Partial<SkillDraft>) => void;
  onSave: () => void;
  onDelete: () => void;
  onReload: () => void;
  onClose: () => void;
  onOpenPrompt: (path: string) => void;
  /** Asking Claude to draft or improve the skill in the editor; left out where Claude is not wired. */
  ask?: SkillAskView;
  onShowSidebar?: () => void;
  history?: PageHistory;
}

/**
 * Skills (#169, ADR-0050): every skill in `.atlas/skills`, an editor for one,
 * and the automations' prompt notes beside them. Every rule — what a name may
 * be, how long a description is, what goes when a skill is deleted — is the
 * domain's, handed in; this page only draws what it is told.
 */
export function SkillsPage(props: SkillsPageProps) {
  const count = props.skills.items?.length ?? 0;
  const lists = useFocusSent(props);
  return (
    <>
      <PageBar
        crumb={{ icon: 'skill', parent: 'Skills' }}
        name="All skills"
        {...(count > 0 && { count: `${count} ${count === 1 ? 'skill' : 'skills'}` })}
        actions={
          <PageAction
            icon="plus"
            label="New skill"
            tone="primary"
            expanded={props.editor?.mode === 'new'}
            onPress={props.onNew}
          />
        }
        {...(props.onShowSidebar !== undefined && { onShowSidebar: props.onShowSidebar })}
        {...(props.history !== undefined && { history: props.history })}
      />
      <div className="panel__body">
        <article className="page page--wide skills" aria-label="Skills">
          <HiddenTitle>All skills</HiddenTitle>
          {props.notice !== null && (
            <p className="skills__notice" role="alert">
              {props.notice}
            </p>
          )}
          <div className="skills__layout">
            <div className="skills__lists" ref={lists}>
              <SkillList {...props} />
              <PromptList prompts={props.prompts} onOpenPrompt={props.onOpenPrompt} />
            </div>
            {props.editor !== null && (
              // One editor per skill: what was typed in is not carried to the next.
              <SkillEditor key={props.selected ?? ''} {...props} editor={props.editor} />
            )}
          </div>
          {props.deleteQuestion !== null && <DeleteSkillDialog {...props.deleteQuestion} />}
          {props.discardQuestion !== null && <DiscardDialog {...props.discardQuestion} />}
        </article>
      </div>
    </>
  );
}

/**
 * Puts the focus where it is sent — a skill's row, or the list's heading —
 * once that is drawn, and says so. The editor it was in has gone (a delete),
 * so without this it would fall to the page's body.
 */
function useFocusSent({
  focusTarget,
  onFocused,
  skills,
}: Pick<SkillsPageProps, 'focusTarget' | 'onFocused' | 'skills'>) {
  const lists = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusTarget === null || lists.current === null) return;
    const selector =
      focusTarget.kind === 'row'
        ? `[data-skill="${CSS.escape(focusTarget.name)}"]`
        : '#skills-heading';
    // A row not in the list once it is read — the skill went too — sends the focus to the heading.
    const target =
      lists.current.querySelector<HTMLElement>(selector) ??
      (skills.items === null ? null : lists.current.querySelector<HTMLElement>('#skills-heading'));
    if (target === null) return;
    target.focus();
    onFocused();
  }, [focusTarget, onFocused, skills]);
  return lists;
}

/** A group's heading and its body: the list, or why there is none. */
function Group({
  id,
  title,
  listed,
  empty,
  children,
}: {
  id: string;
  title: string;
  listed: ListedOr<unknown>;
  empty: string;
  children: ReactNode;
}) {
  let body = children;
  if (listed.error !== null) {
    body = (
      <p className="table__error" role="alert">
        {listed.error}
      </p>
    );
  } else if (listed.items === null) body = <p className="table__empty">Reading…</p>;
  else if (listed.items.length === 0) body = <p className="skills__empty">{empty}</p>;
  return (
    <section className="skills__group" aria-labelledby={id}>
      {/* Focusable from code, so the focus has somewhere to go when the last skill is deleted. */}
      <h2 className="skills__heading" id={id} tabIndex={-1}>
        {title}
      </h2>
      {body}
    </section>
  );
}

function SkillList({
  skills,
  selected,
  onSelect,
}: Pick<SkillsPageProps, 'skills' | 'selected' | 'onSelect'>) {
  return (
    <Group
      id="skills-heading"
      title="Skills"
      listed={skills}
      empty="No skills yet. Make one with New skill."
    >
      <ul className="skills__list">
        {(skills.items ?? []).map((skill) => (
          <li key={skill.name}>
            <button
              type="button"
              className={skill.name === selected ? 'skills__row skills__row--on' : 'skills__row'}
              aria-current={skill.name === selected ? 'true' : undefined}
              data-skill={skill.name}
              onClick={() => onSelect(skill.name)}
            >
              <span className="skills__row-head">
                <Icon name="skill" size={16} />
                <span className="skills__name">{skill.name}</span>
                {skill.problems.length > 0 && (
                  <span className="chip skills__chip--problem">
                    {skill.problems.length === 1
                      ? '1 problem'
                      : `${skill.problems.length} problems`}
                  </span>
                )}
              </span>
              {skill.description !== '' && (
                <span className="skills__description">{skill.description}</span>
              )}
              {skill.usedBy !== undefined && skill.usedBy.length > 0 && (
                <span className="skills__used-by">Used by {skill.usedBy.join(', ')}</span>
              )}
              {skill.problems.map((problem) => (
                <span key={problem} className="skills__row-problem">
                  {problem}
                </span>
              ))}
            </button>
          </li>
        ))}
      </ul>
    </Group>
  );
}

function PromptList({ prompts, onOpenPrompt }: Pick<SkillsPageProps, 'prompts' | 'onOpenPrompt'>) {
  return (
    <Group
      id="prompts-heading"
      title="Automation prompts"
      listed={prompts}
      empty="No prompt notes in .atlas/prompts."
    >
      <ul className="skills__list">
        {(prompts.items ?? []).map((prompt) => (
          <li key={prompt.path} className="skills__prompt">
            <Icon name="doc" size={16} />
            <span className="skills__name">{prompt.name}</span>
            <span className="chip skills__chip--prompt">Prompt</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm skills__open"
              aria-label={`Open ${prompt.name} prompt`}
              onClick={() => onOpenPrompt(prompt.path)}
            >
              Open
            </button>
          </li>
        ))}
      </ul>
    </Group>
  );
}

const problemOf = (problems: readonly SkillProblem[], field: SkillField) =>
  problems.find((problem) => problem.field === field)?.message ?? null;

/** A field's problem under it, once the field has been typed in, or at once for a skill read from disk. */
function FieldProblem({ id, problem }: { id: string; problem: string | null }) {
  if (problem === null) return null;
  return (
    <p className="skills__problem" id={id}>
      {problem}
    </p>
  );
}

/** How many characters are left, or over, once a description is within this many of its limit. */
const NEAR_THE_LIMIT = 100;

/** What the counter says aloud near the limit, and nothing before: a count at every key is noise. */
function countSpoken(length: number, limit: number): string {
  const characters = (count: number) => (count === 1 ? '1 character' : `${count} characters`);
  if (length > limit) return `${characters(length - limit)} over the limit`;
  return limit - length <= NEAR_THE_LIMIT ? `${characters(limit - length)} left` : '';
}

function SkillEditor({
  editor,
  onChange,
  onSave,
  onDelete,
  onReload,
  onClose,
  ask,
}: Pick<SkillsPageProps, 'onChange' | 'onSave' | 'onDelete' | 'onReload' | 'onClose' | 'ask'> & {
  editor: SkillEditorState;
}) {
  const { draft, problems, mode, saving } = editor;
  // A new skill's empty fields are not yet wrong: each says so once it is typed in.
  const [touched, setTouched] = useState<ReadonlySet<SkillField>>(
    () => new Set(mode === 'edit' ? ['name', 'description', 'instructions'] : []),
  );
  const shown = (field: SkillField) => (touched.has(field) ? problemOf(problems, field) : null);
  const change = (field: keyof SkillDraft, value: string) => {
    setTouched((was) => new Set([...was, field]));
    onChange({ [field]: value });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Enter submits only while Save is on: a form with its submit off is not sent.
    onSave();
  };
  const label = mode === 'new' ? 'New skill' : `Skill ${draft.name}`;
  return (
    <form className="skills__editor" aria-label={label} onSubmit={submit}>
      {editor.changedOnDisk && <ChangedOnDisk onReload={onReload} />}
      {editor.saveRefusal !== null && (
        <p className="skills__refusal" role="status">
          {editor.saveRefusal}
        </p>
      )}
      {editor.fileProblems.length > 0 && (
        <ul className="skills__file-problems" aria-label="Problems with SKILL.md">
          {editor.fileProblems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <EditorField label="Name" problemId="skill-name-problem" problem={shown('name')}>
        <input
          className={shown('name') === null ? 'field' : 'field field--invalid'}
          type="text"
          value={draft.name}
          readOnly={mode === 'edit' || saving}
          aria-invalid={shown('name') !== null}
          aria-describedby={shown('name') === null ? undefined : 'skill-name-problem'}
          // A new skill is named first: typing goes straight in.
          autoFocus={mode === 'new'}
          spellCheck={false}
          onChange={(event) => change('name', event.target.value)}
        />
      </EditorField>
      <DescriptionField
        editor={editor}
        problem={shown('description')}
        onChange={(value) => change('description', value)}
      />
      <EditorField
        label="Instructions"
        problemId="skill-instructions-problem"
        problem={shown('instructions')}
        aside={<span className="skills__hint">Markdown</span>}
      >
        <textarea
          className={
            shown('instructions') === null
              ? 'field skills__instructions'
              : 'field field--invalid skills__instructions'
          }
          rows={16}
          value={draft.instructions}
          readOnly={saving}
          spellCheck={false}
          aria-invalid={shown('instructions') !== null}
          aria-describedby={
            shown('instructions') === null ? undefined : 'skill-instructions-problem'
          }
          onChange={(event) => change('instructions', event.target.value)}
        />
      </EditorField>
      {ask !== undefined && <SkillAsk ask={ask} saving={saving} />}
      <div className="skills__actions">
        {mode === 'edit' && (
          <button
            type="button"
            className="btn btn--ghost btn--sm skills__delete"
            disabled={editor.deleting}
            onClick={onDelete}
          >
            Delete…
          </button>
        )}
        <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>
          {mode === 'new' ? 'Cancel' : 'Close'}
        </button>
        <button type="submit" className="btn btn--primary btn--sm" disabled={!editor.canSave}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

/** The file changed on disk under typing: Save waits for Reload. */
function ChangedOnDisk({ onReload }: { onReload: () => void }) {
  return (
    <div className="skills__changed" role="status">
      <span>This skill changed on disk since it was opened. Reload first, then save.</span>
      <button type="button" className="btn btn--secondary btn--sm" onClick={onReload}>
        Reload
      </button>
    </div>
  );
}

/**
 * The description, and its count against the limit: the count describes the
 * field, so it is read with it, and is said aloud only near the limit.
 */
function DescriptionField({
  editor,
  problem,
  onChange,
}: {
  editor: SkillEditorState;
  problem: string | null;
  onChange: (value: string) => void;
}) {
  const { descriptionLength: length, descriptionLimit: limit } = editor;
  const described = [
    'skill-description-count',
    ...(problem === null ? [] : ['skill-description-problem']),
  ];
  return (
    <EditorField
      label="Description"
      problemId="skill-description-problem"
      problem={problem}
      aside={
        <span
          id="skill-description-count"
          className={length > limit ? 'skills__count skills__count--over' : 'skills__count'}
        >
          {length}/{limit}
        </span>
      }
    >
      <textarea
        className={problem === null ? 'field' : 'field field--invalid'}
        rows={3}
        value={editor.draft.description}
        readOnly={editor.saving}
        aria-invalid={problem !== null}
        aria-describedby={described.join(' ')}
        // Typing goes straight into a skill just made: its name is set, and this is next.
        autoFocus={editor.justCreated}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="visually-hidden skills__count-live" aria-live="polite">
        {countSpoken(length, limit)}
      </span>
    </EditorField>
  );
}

function EditorField({
  label,
  problemId,
  problem,
  aside,
  children,
}: {
  label: string;
  problemId: string;
  problem: string | null;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="skills__field">
      <label className="skills__label">
        <span className="skills__label-row">
          <span className="page-form__label">{label}</span>
          {aside}
        </span>
        {children}
      </label>
      <FieldProblem id={problemId} problem={problem} />
    </div>
  );
}

/**
 * A question that must be answered: an alert dialog, so a stray click outside
 * cannot answer it, with the safe answer first, where focus starts.
 */
function Question({
  title,
  body,
  safe,
  act,
  onSafe,
  onAct,
}: {
  title: string;
  body: string;
  safe: string;
  act: string;
  onSafe: () => void;
  onAct: () => void;
}) {
  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onSafe();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Viewport className="palette__backdrop">
          <AlertDialog.Popup className="palette confirm">
            <AlertDialog.Title className="confirm__title">{title}</AlertDialog.Title>
            <AlertDialog.Description className="confirm__body">{body}</AlertDialog.Description>
            <div className="confirm__actions">
              {/* First, so it is where the focus starts. */}
              <AlertDialog.Close className="btn btn--secondary">{safe}</AlertDialog.Close>
              <button type="button" className="btn btn--danger" onClick={onAct}>
                {act}
              </button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** Before a skill's folder goes to the Trash, in the domain's words. */
function DeleteSkillDialog({ warning, onConfirm, onCancel }: SkillDeleteQuestion) {
  return (
    <Question
      title="Delete this skill?"
      body={warning}
      safe="Cancel"
      act="Move to Trash"
      onSafe={onCancel}
      onAct={onConfirm}
    />
  );
}

/** Before typing not saved is thrown away. */
function DiscardDialog({ name, onKeep, onDiscard }: SkillDiscardQuestion) {
  const what = name === null ? 'the new skill' : `“${name}”`;
  return (
    <Question
      title="Discard your changes?"
      body={`What you typed in ${what} is not saved, and will be lost.`}
      safe="Keep editing"
      act="Discard"
      onSafe={onKeep}
      onAct={onDiscard}
    />
  );
}
