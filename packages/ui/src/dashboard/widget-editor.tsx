import { useId, type ReactNode } from 'react';
import { Dialog } from '../dialog.tsx';
import {
  GRID_COLUMNS,
  SQL_SHOWS,
  WIDGET_ICONS,
  WIDGET_KIND_LABELS,
  WIDGET_KINDS,
  type KindOptions,
  type QueryFilter,
  type SqlShow,
  type WidgetDraft,
  type WidgetIcon,
  type WidgetKind,
} from '@dfai/domain';
import type { WidgetResult } from '@dfai/application';
import { Icon, widgetGlyph, widgetKindGlyph } from '../icon.tsx';
import type { OverlaySlot } from '../overlay-slot.ts';
import { FilterList, type ViewField } from '../view-query-popovers.tsx';
import { WidgetTile } from './widget-tile.tsx';

/** A choice in one of the editor's lists: what is stored, and what is shown. */
export interface EditorChoice {
  readonly value: string;
  readonly label: string;
}

export interface WidgetEditorProps {
  mode: 'add' | 'edit';
  draft: WidgetDraft;
  /** Which settings the draft's kind reads; the others are not offered. */
  options: KindOptions;
  /** What the widget is called when its title is left blank. */
  defaultTitle: string;
  /** What stops the draft being saved, in words. Empty: it can be. */
  problems: readonly string[];
  /** The draft, run as the dashboard would run it; null while it is not a widget yet. */
  preview: WidgetResult | null;
  types: readonly EditorChoice[];
  /** Saved views a widget can start from, by path. */
  views: readonly EditorChoice[];
  /** What the draft's type can be filtered by. */
  fields: readonly ViewField[];
  /** What the draft's type can be grouped by. */
  groupings: readonly EditorChoice[];
  /** Values the grouping takes, for calling one out. */
  groupValues: readonly string[];
  onChange: (draft: WidgetDraft) => void;
  onKind: (kind: WidgetKind) => void;
  onType: (type: string) => void;
  onStartFromView: (path: string) => void;
  onSave: () => void;
  onClose: () => void;
  /** The sheet's open state, when the app holds it (the one-overlay rule). */
  slot?: OverlaySlot | undefined;
}

/**
 * The side sheet a widget is added or edited in: its settings on the left of
 * the eye's path, the widget itself above them, redrawn as they change.
 * Settings the chosen kind does not read are not offered.
 */
export function WidgetEditor(props: WidgetEditorProps) {
  const { mode, problems, slot, onClose, onSave } = props;
  const heading = mode === 'add' ? 'Add widget' : 'Edit widget';
  return (
    <Dialog.Root
      open={slot?.open ?? true}
      onOpenChange={(open) => {
        slot?.onOpenChange(open);
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="widget-sheet__backdrop" />
        <Dialog.Popup className="widget-sheet" aria-label={heading}>
          <header className="widget-sheet__head">
            <Dialog.Title className="widget-sheet__title">{heading}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="Close">
              <Icon name="close" size={18} />
            </Dialog.Close>
          </header>
          <section className="widget-sheet__preview" aria-label="Preview">
            {props.preview === null ? (
              <p className="widget-sheet__no-preview">
                The preview appears once the widget can be drawn.
              </p>
            ) : (
              <WidgetTile result={props.preview} onOpenNote={() => undefined} />
            )}
          </section>
          {/* Not a form: the filter rows inside are forms of their own, and a
              submit inside a form inside a form reaches both. */}
          <div className="widget-sheet__form">
            <WidgetSettings {...props} />
            {problems.length > 0 && (
              <ul className="widget-sheet__problems" aria-live="polite">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
            <footer className="widget-sheet__foot">
              <Dialog.Close className="btn btn--secondary btn--sm">Cancel</Dialog.Close>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={problems.length > 0}
                onClick={onSave}
              >
                {mode === 'add' ? 'Add widget' : 'Save'}
              </button>
            </footer>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function WidgetSettings(props: WidgetEditorProps) {
  const { draft, onChange } = props;
  const set = (change: Partial<WidgetDraft>) => onChange({ ...draft, ...change });
  return (
    <>
      <Field label="Title">
        {(id) => (
          <input
            id={id}
            className="field"
            value={draft.title}
            placeholder={props.defaultTitle}
            onChange={(event) => set({ title: event.target.value })}
          />
        )}
      </Field>
      <KindPicker kind={draft.kind} onKind={props.onKind} />
      {draft.kind === 'sql' ? (
        <SqlFields draft={draft} onChange={onChange} />
      ) : (
        <QueryFields {...props} />
      )}
      <Field label="Width">
        {(id) => (
          <span className="widget-sheet__width">
            <input
              id={id}
              type="range"
              min={1}
              max={GRID_COLUMNS}
              value={draft.span}
              onChange={(event) => set({ span: Number(event.target.value) })}
            />
            <output htmlFor={id}>
              {draft.span} of {GRID_COLUMNS} columns
            </output>
          </span>
        )}
      </Field>
    </>
  );
}

/** A `sql` widget's settings: the statement, and how its result is drawn. */
function SqlFields({
  draft,
  onChange,
}: {
  draft: WidgetDraft;
  onChange: (draft: WidgetDraft) => void;
}) {
  return (
    <>
      <Field label="SQL">
        {(id) => (
          <textarea
            id={id}
            className="field field--block widget-sheet__sql"
            spellCheck={false}
            rows={5}
            value={draft.sql}
            onChange={(event) => onChange({ ...draft, sql: event.target.value })}
          />
        )}
      </Field>
      <Field label="Show as">
        {(id) => (
          <Select
            id={id}
            value={draft.show}
            onChange={(show) => onChange({ ...draft, show: show as SqlShow })}
            choices={SQL_SHOWS.map((show) => ({ value: show, label: SQL_SHOW_LABELS[show] }))}
          />
        )}
      </Field>
    </>
  );
}

const SQL_SHOW_LABELS: Readonly<Record<SqlShow, string>> = {
  table: 'Table',
  number: 'Number (the first cell)',
  bar: 'Bar chart (label, value)',
};

/** What a widget over a type asks: the type, its grouping, filters and the kind's own settings. */
function QueryFields(props: WidgetEditorProps) {
  const { draft, options, onChange } = props;
  const set = (change: Partial<WidgetDraft>) => onChange({ ...draft, ...change });
  return (
    <>
      <SourceFields {...props} />
      {options.groupBy !== 'none' && (
        <Field label="Group by">
          {(id) => (
            <Select
              id={id}
              value={draft.groupBy}
              onChange={(groupBy) => set({ groupBy })}
              choices={[
                { value: '', label: options.groupBy === 'required' ? 'Choose a property' : 'None' },
                ...props.groupings,
              ]}
            />
          )}
        </Field>
      )}
      <FilterGroup
        // A fresh "add a filter" row for each type: its property list is the type's.
        key={`filters-${draft.type}`}
        legend="Filters"
        fields={props.fields}
        filters={draft.filters}
        onChange={(filters) => set({ filters })}
        empty="Nothing filtered: every note of the type is counted."
      />
      <KindSettings {...props} />
    </>
  );
}

/** Where the widget's notes come from: a type, or a saved view's type and filters. */
function SourceFields({ draft, types, views, onType, onStartFromView }: WidgetEditorProps) {
  const known = types.some((type) => type.value === draft.type);
  return (
    <div className="widget-sheet__row">
      <Field label="Type">
        {(id) => (
          <Select
            id={id}
            value={draft.type}
            onChange={onType}
            choices={[
              ...(draft.type === '' ? [{ value: '', label: 'Choose a type' }] : []),
              ...(known || draft.type === '' ? [] : [{ value: draft.type, label: draft.type }]),
              ...types,
            ]}
          />
        )}
      </Field>
      {views.length > 0 && (
        <Field label="Start from a view">
          {(id) => (
            <Select
              id={id}
              value=""
              onChange={(path) => {
                if (path !== '') onStartFromView(path);
              }}
              choices={[{ value: '', label: 'Choose a view' }, ...views]}
            />
          )}
        </Field>
      )}
    </div>
  );
}

/** The settings only some kinds read. */
function KindSettings({ draft, options, onChange, fields, groupValues }: WidgetEditorProps) {
  const set = (change: Partial<WidgetDraft>) => onChange({ ...draft, ...change });
  return (
    <>
      {options.highlight && (
        <Field label="Call out">
          {(id) => (
            <Select
              id={id}
              value={draft.highlight}
              onChange={(highlight) => set({ highlight })}
              choices={highlightChoices(draft.highlight, groupValues)}
            />
          )}
        </Field>
      )}
      {options.icon && <IconPicker icon={draft.icon} onIcon={(icon) => set({ icon })} />}
      {options.progress && (
        <FilterGroup
          key={`progress-${draft.type}`}
          legend="Progress"
          fields={fields}
          filters={draft.progress}
          onChange={(progress) => set({ progress })}
          empty="No finished part. Add a filter for it to show a share and a status bar — status is done, say."
        />
      )}
      {options.limit && (
        <Field label={draft.kind === 'rank' ? 'Groups shown' : 'Rows shown'}>
          {(id) => (
            <input
              id={id}
              className="field"
              type="number"
              inputMode="numeric"
              min={1}
              placeholder={draft.kind === 'rank' ? '5' : 'All'}
              value={draft.limit ?? ''}
              onChange={(event) =>
                set({ limit: event.target.value === '' ? null : Number(event.target.value) })
              }
            />
          )}
        </Field>
      )}
    </>
  );
}

function highlightChoices(current: string, values: readonly string[]): EditorChoice[] {
  const named = [
    { value: '', label: 'The usual one' },
    { value: 'max', label: 'The largest' },
    { value: 'last', label: 'The last' },
    { value: 'none', label: 'None' },
  ];
  const isNamed = (value: string) => named.some((choice) => choice.value === value);
  const keys = [...new Set([...values, current])].filter((value) => !isNamed(value));
  return [...named, ...keys.map((value) => ({ value, label: value }))];
}

function KindPicker({ kind, onKind }: { kind: WidgetKind; onKind: (kind: WidgetKind) => void }) {
  return (
    <fieldset className="widget-sheet__group">
      <legend className="widget-sheet__label">Kind</legend>
      <div className="widget-sheet__kinds" role="radiogroup" aria-label="Kind">
        {WIDGET_KINDS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="radio"
            aria-checked={candidate === kind}
            className="widget-sheet__kind"
            onClick={() => onKind(candidate)}
          >
            <Icon name={widgetKindGlyph(candidate)} size={20} />
            {WIDGET_KIND_LABELS[candidate]}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function IconPicker({
  icon,
  onIcon,
}: {
  icon: WidgetIcon | null;
  onIcon: (icon: WidgetIcon | null) => void;
}) {
  return (
    <fieldset className="widget-sheet__group">
      <legend className="widget-sheet__label">Icon</legend>
      <div className="widget-sheet__icons" role="radiogroup" aria-label="Icon">
        <button
          type="button"
          role="radio"
          aria-checked={icon === null}
          className="widget-sheet__icon widget-sheet__icon--none"
          onClick={() => onIcon(null)}
        >
          None
        </button>
        {WIDGET_ICONS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="radio"
            aria-checked={candidate === icon}
            aria-label={candidate}
            className="widget-sheet__icon"
            onClick={() => onIcon(candidate)}
          >
            <Icon name={widgetGlyph(candidate)} size={18} />
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function FilterGroup({
  legend,
  fields,
  filters,
  onChange,
  empty,
}: {
  legend: string;
  fields: readonly ViewField[];
  filters: readonly QueryFilter[];
  onChange: (filters: readonly QueryFilter[]) => void;
  empty: string;
}) {
  return (
    <fieldset className="widget-sheet__group widget-sheet__filters" aria-label={legend}>
      <legend className="widget-sheet__label">{legend}</legend>
      <FilterList fields={fields} filters={filters} onChange={onChange} empty={empty} />
    </fieldset>
  );
}

/** A labelled control: the label above, the control under it. */
function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="widget-sheet__field">
      <label className="widget-sheet__label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
    </div>
  );
}

function Select({
  id,
  value,
  choices,
  onChange,
}: {
  id: string;
  value: string;
  choices: readonly EditorChoice[];
  onChange: (value: string) => void;
}) {
  return (
    <span className="select">
      <select
        id={id}
        className="field select__control"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    </span>
  );
}
