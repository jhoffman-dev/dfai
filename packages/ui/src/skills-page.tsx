import { useState, type FormEvent, type ReactNode } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import type { SkillDraft, SkillField, SkillProblem } from '@dfai/domain';
import { Icon } from './icon.tsx';
import { PageAction, PageBar, type PageHistory } from './page-bar.tsx';
import { HiddenTitle } from './page-head.tsx';

/** A skill as the list shows it: what it says it does, and what is wrong with it, in the domain's words. */
export interface SkillListing {
  readonly name: string;
  readonly description: string;
  readonly problems: readonly string[];
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
}

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
  onSelect: (name: string) => void;
  onNew: () => void;
  onChange: (change: Partial<SkillDraft>) => void;
  onSave: () => void;
  onDelete: () => void;
  onReload: () => void;
  onClose: () => void;
  onOpenPrompt: (path: string) => void;
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
            <div className="skills__lists">
              <SkillList {...props} />
              <PromptList prompts={props.prompts} onOpenPrompt={props.onOpenPrompt} />
            </div>
            {props.editor !== null && (
              // One editor per skill: what was typed in is not carried to the next.
              <SkillEditor key={props.selected ?? ''} {...props} editor={props.editor} />
            )}
          </div>
          {props.deleteQuestion !== null && <DeleteSkillDialog {...props.deleteQuestion} />}
        </article>
      </div>
    </>
  );
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
      <h2 className="skills__heading" id={id}>
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

function SkillEditor({
  editor,
  onChange,
  onSave,
  onDelete,
  onReload,
  onClose,
}: Pick<SkillsPageProps, 'onChange' | 'onSave' | 'onDelete' | 'onReload' | 'onClose'> & {
  editor: SkillEditorState;
}) {
  const { draft, problems, mode } = editor;
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
  const over = editor.descriptionLength > editor.descriptionLimit;
  const label = mode === 'new' ? 'New skill' : `Skill ${draft.name}`;
  return (
    <form className="skills__editor" aria-label={label} onSubmit={submit}>
      {editor.changedOnDisk && (
        <div className="skills__changed" role="status">
          <span>This skill changed on disk since it was opened.</span>
          <button type="button" className="btn btn--secondary btn--sm" onClick={onReload}>
            Reload
          </button>
        </div>
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
          readOnly={mode === 'edit'}
          aria-invalid={shown('name') !== null}
          aria-describedby={shown('name') === null ? undefined : 'skill-name-problem'}
          // A new skill is named first: typing goes straight in.
          autoFocus={mode === 'new'}
          spellCheck={false}
          onChange={(event) => change('name', event.target.value)}
        />
      </EditorField>
      <EditorField
        label="Description"
        problemId="skill-description-problem"
        problem={shown('description')}
        aside={
          <span
            className={over ? 'skills__count skills__count--over' : 'skills__count'}
            aria-label={`${editor.descriptionLength} of ${editor.descriptionLimit} characters`}
          >
            {editor.descriptionLength}/{editor.descriptionLimit}
          </span>
        }
      >
        <textarea
          className={shown('description') === null ? 'field' : 'field field--invalid'}
          rows={3}
          value={draft.description}
          aria-invalid={shown('description') !== null}
          aria-describedby={shown('description') === null ? undefined : 'skill-description-problem'}
          onChange={(event) => change('description', event.target.value)}
        />
      </EditorField>
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
          spellCheck={false}
          aria-invalid={shown('instructions') !== null}
          aria-describedby={
            shown('instructions') === null ? undefined : 'skill-instructions-problem'
          }
          onChange={(event) => change('instructions', event.target.value)}
        />
      </EditorField>
      <div className="skills__actions">
        {mode === 'edit' && (
          <button
            type="button"
            className="btn btn--ghost btn--sm skills__delete"
            onClick={onDelete}
          >
            Delete…
          </button>
        )}
        <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>
          {mode === 'new' ? 'Cancel' : 'Close'}
        </button>
        <button
          type="submit"
          className="btn btn--primary btn--sm"
          disabled={problems.length > 0 || editor.saving}
        >
          {editor.saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
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
 * The question before a skill's folder goes to the Trash: an alert dialog,
 * so a stray click outside cannot answer it, with Cancel where focus starts.
 */
function DeleteSkillDialog({ warning, onConfirm, onCancel }: SkillDeleteQuestion) {
  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Viewport className="palette__backdrop">
          <AlertDialog.Popup className="palette confirm">
            <AlertDialog.Title className="confirm__title">Delete this skill?</AlertDialog.Title>
            <AlertDialog.Description className="confirm__body">{warning}</AlertDialog.Description>
            <div className="confirm__actions">
              {/* First, so it is where the focus starts. */}
              <AlertDialog.Close className="btn btn--secondary">Cancel</AlertDialog.Close>
              <button type="button" className="btn btn--danger" onClick={onConfirm}>
                Move to Trash
              </button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
