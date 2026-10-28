import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  createVaultPath,
  formatPropertyDate,
  linkedNames,
  hasOpenQuote,
  listAsInput,
  listEditText,
  listFromEditText,
  linkedNotes,
  optionColor,
  optionLabel,
  propertyIcon,
  relationHue,
  relationTypes,
  relationTypesText,
  withDatePart,
  withLink,
  withoutLink,
  type PropertyDef,
  type VaultPath,
} from '@dfai/domain';
import { pillPaint } from './pill-paint.ts';
import { AddPropertyPopover, type NewProperty } from './add-property-popover.tsx';
import { Icon, propertyGlyph } from './icon.tsx';
import { LinkedNote, useNoteNames } from './note-names.tsx';
import { useLinkInText } from './link-suggest/use-link-in-text.tsx';
import { linksTo, RelationPicker } from './relation-options.tsx';
import type { RelationTarget } from './type-editor.tsx';

export type { NewProperty } from './add-property-popover.tsx';

export interface PropertyRow {
  readonly def: PropertyDef;
  readonly value: unknown;
  readonly error: string | null;
}

/** Makes a note of type `target` called `name`; resolves with the link to write. */
export type CreateRelated = (args: { target: string; name: string }) => Promise<string>;

export interface RelationChoice {
  readonly path: string;
  readonly title: string;
  /** The type it is, where the relation points at several. */
  readonly type?: string;
}

/**
 * A note's properties, above its text, as quiet rows: a glyph and a label,
 * then the value — a status as a pill, a date as a date is read.
 *
 * Every editor writes straight to frontmatter, so what is shown here is what is
 * in the file. A relation offers only notes of the type it points at — picking
 * the wrong kind of thing is not something to validate after the fact, it is
 * something not to offer.
 */
export function PropertiesPanel({
  typeName,
  typeLabel = null,
  rows,
  relationChoices,
  relationTargets: targets = [],
  onChange,
  onAdd,
  onOpenNote,
  onCreateRelated,
  fileKeys = [],
  customValues = {},
  folded = [],
}: {
  /** A typed note has a panel even with nothing filled in yet. */
  typeName: string | null;
  /** The type as a person reads it, which a property can be added to; null for none. */
  typeLabel?: string | null;
  rows: readonly PropertyRow[];
  /**
   * Every key the note's frontmatter holds, shown here or not (`type`, a title
   * heading the page). Adding one of them would write an empty value over it.
   */
  fileKeys?: readonly string[];
  /** Candidates per relation key, already filtered to the target type. */
  relationChoices: Readonly<Record<string, readonly RelationChoice[]>>;
  /** The types a new relation can point at. */
  relationTargets?: readonly RelationTarget[];
  /**
   * Sets a property. A function is a rule — add this link, take that one out —
   * to be worked out against the value in the file when the write runs, so a
   * second link picked before the first is back adds to it.
   */
  onChange: (key: string, value: unknown) => void;
  /**
   * Given when a property can be added here. Resolves with the key it was
   * stored under, whose row then takes the focus; rejects with why not.
   */
  onAdd?: (property: NewProperty) => Promise<string>;
  /** Opens a note a relation links; left out, its chips are names alone. */
  onOpenNote?: (path: VaultPath) => void;
  /**
   * Makes a new note of the type a relation points at, named as typed, and
   * resolves with the link to it; rejects with why not. Left out, a relation
   * offers only the notes there are.
   */
  onCreateRelated?: CreateRelated;
  /**
   * A value drawn by the caller instead of an editor, by key, given the id
   * the row's label points at — an artifact's thumbnail, shown as a picture.
   */
  customValues?: Readonly<Record<string, (id: string) => ReactNode>>;
  /**
   * Keys whose rows the caller folds away for now — the aside's empty ones.
   * They are still the note's rows: a panel with every row folded is a panel,
   * with its add, not nothing.
   */
  folded?: readonly string[];
}) {
  // Two panes can show the same note, so a key alone does not name one field.
  const idPrefix = useId();
  const [adding, setAdding] = useState(false);
  /** The property just added, focused as soon as its row is there. */
  const focusKey = useRef<string | null>(null);
  const focusAdded = useCallback(() => {
    const field =
      focusKey.current === null ? null : document.getElementById(`${idPrefix}-${focusKey.current}`);
    if (field === null) return;
    field.focus();
    focusKey.current = null;
  }, [idPrefix]);
  // The row arrives when the file or the type does, some renders after the add.
  useEffect(focusAdded, [rows, focusAdded]);

  if (rows.length === 0 && typeName === null) return null;

  return (
    <section className="props" aria-label="Properties">
      <dl className="props__list">
        {rows.map((row) =>
          folded.includes(row.def.key) ? null : (
            <div className="props__row" key={row.def.key}>
              <dt className="props__label">
                <Icon name={propertyGlyph(propertyIcon(row.def.kind))} size={16} />
                <label htmlFor={`${idPrefix}-${row.def.key}`}>{row.def.label}</label>
              </dt>
              <dd className="props__value">
                {customValues[row.def.key]?.(`${idPrefix}-${row.def.key}`) ?? (
                  <PropertyEditor
                    id={`${idPrefix}-${row.def.key}`}
                    row={row}
                    choices={relationChoices[row.def.key] ?? []}
                    onChange={(value) => onChange(row.def.key, value)}
                    {...(onOpenNote !== undefined && { onOpenNote })}
                    {...(onCreateRelated !== undefined && { onCreateRelated })}
                  />
                )}
                {row.error !== null && (
                  <span className="props__error" role="alert">
                    {row.error}
                  </span>
                )}
              </dd>
            </div>
          ),
        )}
      </dl>
      {onAdd !== undefined && (
        <div className="props__add-anchor">
          <button
            type="button"
            className="props__add"
            aria-expanded={adding}
            onClick={() => setAdding(true)}
          >
            <Icon name="plus" size={16} />
            Add a property
          </button>
          {adding && (
            <AddPropertyPopover
              existing={[...rows.map((row) => row.def.key), ...fileKeys]}
              typeName={typeName}
              typeLabel={typeName === null ? null : typeLabel}
              targets={targets}
              onAdd={async (property) => {
                focusKey.current = await onAdd(property);
                focusAdded();
              }}
              onClose={() => setAdding(false)}
            />
          )}
        </div>
      )}
    </section>
  );
}

/** Whether a value is a list of things or a mapping, rather than one value. */
function isStructured(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => typeof item === 'object' && item !== null);
  }
  return typeof value === 'object' && value !== null;
}

function StructuredValue({ id, value }: { id: string; value: unknown }) {
  const count = Array.isArray(value) ? value.length : Object.keys(value as object).length;
  const noun = Array.isArray(value) ? 'item' : 'key';

  return (
    <div className="props__structured" id={id}>
      <span className="props__structured-count">
        {count} {count === 1 ? noun : `${noun}s`}
      </span>
      <span className="props__structured-note">edited in the note&rsquo;s properties</span>
    </div>
  );
}

/** Changes a single-valued property, clearing it rather than storing an empty string. */
const single =
  (onChange: (value: unknown) => void) =>
  (event: { target: { value: string } }): void =>
    onChange(event.target.value === '' ? null : event.target.value);

interface EditorProps {
  id: string;
  row: PropertyRow;
  /** The value as text: '' for nothing. */
  text: string;
  onChange: (value: unknown) => void;
}

function PropertyEditor({
  id,
  row,
  choices,
  onChange,
  onOpenNote,
  onCreateRelated,
}: {
  id: string;
  row: PropertyRow;
  choices: readonly RelationChoice[];
  onChange: (value: unknown) => void;
  onOpenNote?: (path: VaultPath) => void;
  onCreateRelated?: CreateRelated;
}) {
  const text = row.value === null || row.value === undefined ? '' : String(row.value);
  const props: EditorProps = { id, row, text, onChange };

  // A value with structure inside it — a dashboard's `widgets`, a view's
  // `filters` — has no honest text box. `String()` renders it
  // "[object Object]", and typing one character into that would write the
  // string over the structure and take the dashboard with it. It is shown
  // instead, and edited in the frontmatter where it can be seen whole.
  if (isStructured(row.value)) {
    return <StructuredValue id={id} value={row.value} />;
  }

  switch (row.def.kind) {
    case 'checkbox':
      return <CheckboxEditor {...props} />;
    case 'number':
      return <NumberEditor {...props} />;
    case 'date':
      return <DateEditor id={id} label={row.def.label} value={text} onChange={onChange} />;
    case 'select':
      return <SelectEditor {...props} />;
    case 'multiSelect':
      return <MultiSelectEditor {...props} />;
    case 'relation':
      return (
        <RelationEditor
          id={id}
          row={row}
          onChange={onChange}
          choices={choices}
          {...(onOpenNote !== undefined && { onOpenNote })}
          {...(onCreateRelated !== undefined && { onCreateRelated })}
        />
      );
    default:
      return <TextEditor {...props} />;
  }
}

function CheckboxEditor({ id, row, onChange }: EditorProps) {
  return (
    <input
      id={id}
      className="props__check"
      type="checkbox"
      checked={row.value === true || row.value === 'true'}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

/**
 * What a typed-in field shows: while it has the focus, what was typed there;
 * otherwise what the file says.
 *
 * Each keystroke is written, and the file's value comes back a moment later.
 * Shown instead, it would put each keystroke back until then — "412" typed
 * quickly reached the file as "42" — and a list typed as "a, " would lose its
 * comma to the list it reads back as.
 *
 * `held` says when what was typed is not saved yet; Esc then puts back what
 * the file says, as leaving the field does.
 */
function useTyping(
  fileText: string,
  write: (typed: string) => void,
  held?: (typed: string) => boolean,
) {
  const [typed, setTyped] = useState<string | null>(null);
  return {
    value: typed ?? fileText,
    onFocus: () => setTyped(fileText),
    onBlur: () => setTyped(null),
    ...(held !== undefined && {
      onKeyDown: (event: { key: string }) => {
        if (event.key === 'Escape' && typed !== null && held(typed)) setTyped(fileText);
      },
    }),
    onChange: (event: { target: { value: string } }) => {
      setTyped(event.target.value);
      write(event.target.value);
    },
  };
}

function NumberEditor({ id, text, onChange }: EditorProps) {
  const typing = useTyping(text, (typed) => onChange(typed === '' ? null : Number(typed)));
  return <input id={id} className="props__input props__input--number" type="number" {...typing} />;
}

function SelectEditor({ id, row, text, onChange }: EditorProps) {
  return (
    <span className="props__pill" {...pillPaint(text === '' ? null : optionColor(row.def, text))}>
      <span className="props__dot" aria-hidden="true" />
      <select id={id} className="props__pill-select" value={text} onChange={single(onChange)}>
        <option value="">—</option>
        {offeredOptions(row.def.options, text).map((option) => (
          <option key={option} value={option}>
            {optionLabel(option)}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * The options a select offers, with the one the note holds kept on the list
 * even when the type no longer offers it, so the pill still says what the file says.
 */
function offeredOptions(options: readonly string[], held: string): readonly string[] {
  return held === '' || options.includes(held) ? options : [...options, held];
}

/**
 * A multi-select as one line, in the shared list codec: commas between the
 * items, and an item holding a comma of its own — `"Payroll, Larkspur"` —
 * quoted, so editing one item never cuts another in two (#50). An item left
 * as it was shown is saved as the file held it, and nothing is saved while a
 * quote is open: leaving the field or Esc then shows the file's list again.
 */
function MultiSelectEditor({ id, row, onChange }: EditorProps) {
  const typing = useTyping(
    listEditText(row.value),
    (typed) => {
      const list = listFromEditText(typed, row.value);
      if (list !== null) onChange(list);
    },
    hasOpenQuote,
  );
  return (
    <input
      id={id}
      className="props__input"
      type="text"
      placeholder={listAsInput(row.def.options)}
      {...typing}
    />
  );
}

/**
 * A relation: a chip for each note it links, named as the note is and opening
 * it, with its own remove — then a picker that stays, offering the notes not
 * linked yet. Picking for a relation that holds one note puts it in place of
 * the one there.
 *
 * A link is written the way the note is found (`linkTo`), so a note that
 * titles itself is still linked by the name its file answers to.
 */
function RelationEditor({
  id,
  row,
  onChange,
  choices,
  onOpenNote,
  onCreateRelated,
}: {
  id: string;
  row: PropertyRow;
  onChange: (value: unknown) => void;
  choices: readonly RelationChoice[];
  onOpenNote?: (path: VaultPath) => void;
  onCreateRelated?: CreateRelated;
}) {
  const names = useNoteNames();
  const links = linkedNotes(row.value);
  const { label, many } = row.def;
  const pointsAt = relationTypes(row.def);
  const unlinked = choices.filter(
    (choice) => !links.some((link) => linksTo(link, createVaultPath(choice.path), names)),
  );
  const what = relationTypesText(row.def);
  const prompt = many
    ? `Add a ${what}…`
    : links.length === 0
      ? `— no ${what} —`
      : `Change ${what}…`;
  /** Puts a link in, as picking one does: in place of the one there, or beside them. */
  const link = (picked: string) =>
    onChange(
      many ? (current: unknown) => withLink({ value: current, link: picked, many }) : picked,
    );

  return (
    <div className="props__links">
      {links.length > 0 && (
        <ul className="props__link-list" aria-label={label}>
          {links.map((link) => {
            const [name] = linkedNames(link, names);
            const title = name?.text ?? link;
            return (
              <li
                key={link}
                className="props__chip props__link"
                data-hue={
                  name === undefined || name.missing ? undefined : relationHue({ key: name.key })
                }
              >
                <Icon name="task" size={15} className="props__chip-icon" />
                {name === undefined ? (
                  <span className="props__link-title">{link}</span>
                ) : (
                  <LinkedNote
                    name={name}
                    className="props__link-title"
                    {...(onOpenNote !== undefined && { onOpen: onOpenNote })}
                  />
                )}
                <button
                  type="button"
                  className="props__link-remove"
                  aria-label={`Remove ${title} from ${label}`}
                  onClick={() => onChange((current: unknown) => withoutLink(current, link))}
                >
                  <Icon name="close" size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {/* A relation to no type in particular has nothing to offer. */}
      <RelationPicker
        id={id}
        choices={unlinked}
        names={names}
        prompt={prompt}
        pointsAt={pointsAt}
        onPick={link}
        {...(onCreateRelated !== undefined && { onCreateRelated })}
      />
    </div>
  );
}

function TextEditor({ id, row, text, onChange }: EditorProps) {
  const typing = useTyping(text, (typed) => onChange(typed === '' ? null : typed));
  // `[[` in a text field suggests notes, as a link field does (#465); never in a url.
  const links = useLinkInText({
    value: typing.value,
    onText: (typed) => typing.onChange({ target: { value: typed } }),
    onBlur: typing.onBlur,
  });
  if (row.def.kind === 'url') {
    return <input id={id} className="props__input" type="url" placeholder="Empty" {...typing} />;
  }
  return (
    <span className="link-combo">
      <input
        id={id}
        className="props__input"
        type="text"
        placeholder="Empty"
        value={typing.value}
        onFocus={typing.onFocus}
        {...links.field}
      />
      {links.list}
    </span>
  );
}

/**
 * A date read as "Tue, Sep 22, 2026", edited with the platform's date field.
 *
 * The field sits over the words, invisible until it has the focus — so a
 * click or a Tab lands in the real control, with its keyboard and its picker,
 * and nothing about editing a date is reimplemented here.
 *
 * The field reports a day on every keystroke, including ones part-way through
 * (year 0002 on the way to 2027), and '' the moment any part of it is erased —
 * one Backspace. So it writes only when it is left or Enter is pressed, and
 * never writes an empty day: a date is taken away only by its Clear button.
 */
function DateEditor({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: unknown) => void;
}) {
  const day = value.slice(0, 10);
  const [draft, setDraft] = useState(day);
  const [shownDay, setShownDay] = useState(day);
  // A new value from the file replaces whatever was half-typed.
  if (shownDay !== day) {
    setShownDay(day);
    setDraft(day);
  }
  const shown = value === '' ? null : (formatPropertyDate(value) ?? value);

  const commit = () => {
    if (draft === '' || draft === day) setDraft(day);
    else onChange(withDatePart(value, draft));
  };

  return (
    <span className="props__date" data-empty={shown === null}>
      <input
        id={id}
        className="props__input props__date-input"
        type="date"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          // Putting a typed date back answers the Escape: a dialog round the field stays open.
          if (event.key === 'Escape' && draft !== day) {
            event.preventDefault();
            setDraft(day);
          }
        }}
      />
      <span className="props__date-text" aria-hidden="true">
        {shown ?? 'Empty'}
      </span>
      {shown !== null && (
        <button
          type="button"
          className="props__date-clear"
          aria-label={`Clear ${label}`}
          title="Clear"
          onClick={() => onChange(null)}
        >
          <Icon name="close" size={14} />
        </button>
      )}
    </span>
  );
}
