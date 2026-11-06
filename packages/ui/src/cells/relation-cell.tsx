import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Popover } from '@base-ui/react/popover';
import {
  createVaultPath,
  linkedNames,
  linkedNotes,
  relationHue,
  relationTypes,
  relationTypesText,
  withLink,
  withoutLink,
  type NoteNames,
  type PropertyDef,
  type VaultPath,
} from '@dfai/domain';
import { Icon } from '../icon.tsx';
import { LinkedNote, useNoteNames } from '../note-names.tsx';
import type { CreateRelated, RelationChoice } from '../properties-panel.tsx';
import { linksTo, RelationPicker } from '../relation-options.tsx';
import type { CellEditorHooks, CellValue } from './cell-editing.ts';
import { useAnchoring, usePressOnOpenCell, useReturningFocus } from './cell-focus.ts';
import type { CellAt } from './cell-keys.ts';

/**
 * A relation's cell: the notes it links, by name, each opening its note.
 * The cell holds `[[…]]` as the file does; it is never shown that way.
 * Where cells edit and the type says what the relation points at, a button
 * beside the names — the cell's stop — opens its picker under the cell, and
 * the cell wears the ring while that is open. The names stay plain links:
 * nothing is nested in anything that acts as a button.
 */
export function RelationCell({
  at,
  label,
  value,
  editing,
  picks,
  editor,
  onOpenNote,
}: {
  at: CellAt;
  /** The column's label, which names an empty cell: "No project". */
  label: string;
  value: unknown;
  /** Whether this cell's picker is open. */
  editing: boolean;
  /** Whether a picker can open: the type declared what the relation points at. */
  picks: boolean;
  editor: CellEditorHooks | undefined;
  onOpenNote: (path: string) => void;
}) {
  const names = linkedNames(value, useNoteNames());
  const text = names.map((name) => name.text).join(', ');
  const chips = names.map((name, index) => (
    <LinkedNote
      key={index}
      name={name}
      className="table__note"
      hue={relationHue({ key: name.key })}
      onOpen={onOpenNote}
    />
  ));
  if (editor === undefined) {
    return (
      <span className="table__cell table__links" title={text === '' ? undefined : text}>
        {chips}
      </span>
    );
  }
  return (
    <RelationStop at={at} label={label} text={text} editing={editing} picks={picks} editor={editor}>
      {chips}
    </RelationStop>
  );
}

/** The relation cell with its stop: the button that opens the picker and takes the focus back after. */
function RelationStop({
  at,
  label,
  text,
  editing,
  picks,
  editor,
  children,
}: {
  at: CellAt;
  label: string;
  text: string;
  editing: boolean;
  picks: boolean;
  editor: CellEditorHooks;
  children: ReactNode;
}) {
  const cell = useRef<HTMLSpanElement>(null);
  const stop = useRef<HTMLButtonElement>(null);
  useReturningFocus(at, editor, stop);
  useAnchoring(editing, editor, cell);
  const press = usePressOnOpenCell(editing);
  return (
    <span
      ref={cell}
      className="table__cell table__links"
      data-editing={editing ? '' : undefined}
      title={text === '' ? undefined : text}
    >
      <span className="table__link-names">{children}</span>
      <button
        ref={stop}
        type="button"
        className="table__link-edit"
        aria-label={text === '' ? `No ${label.toLowerCase()}` : text}
        {...(picks && { 'aria-haspopup': 'dialog', 'aria-expanded': editing })}
        data-cell-stop={at.column}
        // The stop says it is editing too, as a status cell's button does.
        data-editing={editing ? '' : undefined}
        onPointerDown={press.onPointerDown}
        onPointerLeave={press.onPointerLeave}
        onPointerCancel={press.onPointerCancel}
        onClick={(event) => {
          // Nothing to offer until the type says what the relation points at.
          if (picks && press.opens(event)) editor.start(at);
        }}
      >
        {/* The glyph is the stylesheet's: a component here would draw once per row. */}
        <span className="table__link-glyph" data-glyph={text === '' ? 'add' : 'edit'} />
      </button>
    </span>
  );
}

/**
 * The picker a relation cell opens: a chip per note it links, each with its
 * own remove, then the relation's picker (the properties panel's), offering
 * the notes not linked yet and "New <type>…". Each pick or removal is one
 * write, made on what the picker holds — the last pick's result, not the
 * value last read back, so two quick removals remove both. Esc and a press
 * outside close it.
 */
export function RelationPickerPopover({
  open,
  anchor,
  def,
  value,
  choices,
  onWrite,
  onOpenNote,
  onCancel,
  onCreateRelated,
  problem = null,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  def: Pick<PropertyDef, 'label' | 'many' | 'target' | 'targets'>;
  /** What the cell holds now. */
  value: unknown;
  /** The notes the relation may link. */
  choices: readonly RelationChoice[];
  /** A promise it returns says whether the write landed. */
  onWrite: (value: CellValue) => unknown;
  onOpenNote: (path: VaultPath) => void;
  onCancel: () => void;
  onCreateRelated?: CreateRelated;
  /** Why the notes to link could not be read: said in place of the list, rather than "no notes". */
  problem?: string | null;
}) {
  const held = useHeldValue(value);
  const popup = useRef<HTMLDivElement>(null);
  const write = (next: CellValue) => {
    held.set(next);
    // A write the note refused was reported by whoever refused it; here the
    // picker goes back to showing what the file still holds.
    Promise.resolve(onWrite(next)).catch(held.reset);
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          className="menu-positioner"
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={2}
        >
          <Popover.Popup
            ref={popup}
            className="cell-picker cell-picker--relation"
            aria-label={`Set ${def.label}`}
            // The search field takes the focus, so the next note is typed straight away (#465).
            initialFocus={() =>
              popup.current?.querySelector<HTMLElement>('input[role="combobox"]') ?? true
            }
            finalFocus={false}
          >
            <LinkChips
              label={def.label}
              value={held.value}
              onOpenNote={onOpenNote}
              onRemove={(link) => write(withoutLink(held.value, link))}
            />
            {problem === null ? (
              <LinkPicker
                def={def}
                value={held.value}
                choices={choices}
                onLink={(link) => write(withLink({ value: held.value, link, many: def.many }))}
                {...(onCreateRelated !== undefined && { onCreateRelated })}
              />
            ) : (
              <p className="cell-picker__none" role="alert">
                {problem}
              </p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * What the picker holds: the value as read, then each write's result in
 * turn until the next read — so the second of two quick removals builds on
 * the first, not on the value the file still showed — and the value as
 * read again once a write fails.
 */
export function useHeldValue(read: unknown): {
  value: unknown;
  set: (next: unknown) => void;
  reset: () => void;
} {
  const [value, setValue] = useState(read);
  const [seen, setSeen] = useState(read);
  if (seen !== read) {
    setSeen(read);
    setValue(read);
  }
  const latest = useRef(read);
  useLayoutEffect(() => {
    latest.current = read;
  });
  return { value, set: setValue, reset: () => setValue(latest.current) };
}

/** The notes linked, as chips with their own remove. */
function LinkChips({
  label,
  value,
  onOpenNote,
  onRemove,
}: {
  label: string;
  value: unknown;
  onOpenNote: (path: VaultPath) => void;
  onRemove: (link: string) => void;
}) {
  const names = useNoteNames();
  const links = linkedNotes(value);
  if (links.length === 0) return null;
  return (
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
            {name === undefined ? (
              <span className="props__link-title" title={link}>
                {link}
              </span>
            ) : (
              <LinkedNote name={name} className="props__link-title" hint onOpen={onOpenNote} />
            )}
            <button
              type="button"
              className="props__link-remove"
              aria-label={`Remove ${title} from ${label}`}
              onClick={() => onRemove(link)}
            >
              <Icon name="close" size={12} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The relation's picker, offering the notes not linked yet. */
function LinkPicker({
  def,
  value,
  choices,
  onLink,
  onCreateRelated,
}: {
  def: Pick<PropertyDef, 'label' | 'many' | 'target' | 'targets'>;
  value: unknown;
  choices: readonly RelationChoice[];
  onLink: (link: string) => void;
  onCreateRelated?: CreateRelated;
}) {
  const names = useNoteNames();
  const links = linkedNotes(value);
  const unlinked = choices.filter((choice) => !links.some((link) => linksAt(link, choice, names)));
  const what = relationTypesText(def);
  const prompt = def.many
    ? `Add a ${what}…`
    : links.length === 0
      ? `— no ${what} —`
      : `Change ${what}…`;
  return (
    <RelationPicker
      choices={unlinked}
      names={names}
      prompt={prompt}
      pointsAt={relationTypes(def)}
      onPick={onLink}
      {...(onCreateRelated !== undefined && { onCreateRelated })}
    />
  );
}

function linksAt(link: string, choice: RelationChoice, names: NoteNames): boolean {
  return linksTo(link, createVaultPath(choice.path), names);
}
