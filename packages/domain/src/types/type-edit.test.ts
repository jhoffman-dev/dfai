import { describe, expect, it } from 'vitest';
import { hueOf, optionColor } from '../page/pill-colour.ts';
import { parseObjectType, type ObjectType } from './property-def.ts';
import {
  addOption,
  applyTypeEdit,
  addProperty,
  changePropertyKind,
  moveOption,
  moveProperty,
  NEW_PROPERTY_LABEL,
  newObjectType,
  removeOption,
  removeProperty,
  renameOption,
  renameProperty,
  setOptionColor,
  setPropertyRequired,
  setRelation,
  setTypeIcon,
  setTypeLabel,
  TypeEditError,
  type TypeEdit,
} from './type-edit.ts';

const TASK: ObjectType = parseObjectType({
  name: 'task',
  label: 'Task',
  properties: {
    status: { kind: 'select', options: ['backlog', 'next', 'doing', 'review', 'done'] },
    due: 'date',
    owner: { kind: 'relation', target: 'person' },
    tags: { kind: 'multiSelect', options: ['a', 'b'] },
  },
});

const keys = (type: ObjectType) => type.properties.map((property) => property.key);
const property = (type: ObjectType, key: string) =>
  type.properties.find((candidate) => candidate.key === key);

describe('newObjectType', () => {
  it('names the type from its label, and keeps the icon it was given', () => {
    const type = newObjectType({ label: ' Book club ', icon: 'grid', existing: ['task'] });
    expect(type).toEqual({ name: 'book_club', label: 'Book club', properties: [], icon: 'grid' });
  });

  it('refuses a name that collides, is reserved, or is empty', () => {
    expect(() => newObjectType({ label: 'Task', existing: ['task'] })).toThrow(/already a type/);
    expect(() => newObjectType({ label: 'View', existing: [] })).toThrow(/DFAI uses itself/);
    expect(() => newObjectType({ label: '  ', existing: [] })).toThrow(TypeEditError);
    expect(() => newObjectType({ label: '!!', existing: [] })).toThrow(/needs a name/);
  });

  it('takes a name given outright over the one the label would make', () => {
    expect(newObjectType({ label: 'Books', name: 'book', existing: [] }).name).toBe('book');
  });
});

describe('the type itself', () => {
  it('renames its label, never to nothing', () => {
    expect(setTypeLabel(TASK, ' Chores ').label).toBe('Chores');
    expect(() => setTypeLabel(TASK, '')).toThrow(TypeEditError);
  });

  it('chooses an icon, and forgets it again', () => {
    const chosen = setTypeIcon(TASK, 'board');
    expect(chosen.icon).toBe('board');
    expect('icon' in setTypeIcon(chosen, null)).toBe(false);
  });
});

describe('properties', () => {
  it('adds one at the end under a key made from its label', () => {
    const added = addProperty(TASK, { label: 'Due date', kind: 'date' });
    expect(keys(added).at(-1)).toBe('due_date');
    expect(property(added, 'due_date')).toMatchObject({ kind: 'date', label: 'Due date' });
  });

  it('adds a second one with the same name under a key of its own', () => {
    expect(keys(addProperty(TASK, { label: 'Status' })).at(-1)).toBe('status_2');
  });

  it('points a new relation at the type itself until told otherwise', () => {
    const added = addProperty(TASK, { label: 'Parent', kind: 'relation' });
    expect(property(added, 'parent')).toMatchObject({ target: 'task', many: false });
  });

  it('refuses a property with no name', () => {
    expect(() => addProperty(TASK, { label: ' ' })).toThrow(/needs a name/);
  });

  it('keys a property still called by its placeholder after the first name it is given', () => {
    const added = addProperty(TASK, { label: NEW_PROPERTY_LABEL });
    expect(keys(added).at(-1)).toBe('property');
    const change = renameProperty(added, { key: 'property', newKey: 'property', label: 'Tasks' });
    expect(keys(change.type).at(-1)).toBe('tasks');
    expect(property(change.type, 'tasks')?.label).toBe('Tasks');
    expect(change.migration).toEqual({ kind: 'renameKey', from: 'property', to: 'tasks' });
  });

  it('keys a second placeholder clear of a property already called that', () => {
    const twice = addProperty(addProperty(TASK, { label: 'Property' }), { label: 'Property' });
    const change = renameProperty(twice, {
      key: 'property_2',
      newKey: 'property_2',
      label: 'Status',
    });
    expect(keys(change.type).at(-1)).toBe('status_2');
  });

  it('keeps the key of a property once it has a name of its own', () => {
    const named = renameProperty(addProperty(TASK, { label: 'Property' }), {
      key: 'property',
      newKey: 'property',
      label: 'Tasks',
    }).type;
    const change = renameProperty(named, { key: 'tasks', newKey: 'tasks', label: 'Jobs' });
    expect(keys(change.type).at(-1)).toBe('tasks');
    expect(change.migration).toBeNull();
  });

  it('keeps a key given outright alongside the placeholder name changing', () => {
    const added = addProperty(TASK, { label: 'Property' });
    const change = renameProperty(added, { key: 'property', newKey: 'owner_2', label: 'Owner' });
    expect(keys(change.type).at(-1)).toBe('owner_2');
  });

  it('renames a label alone without anything for the notes to do', () => {
    const change = renameProperty(TASK, { key: 'due', newKey: 'due', label: 'Deadline' });
    expect(property(change.type, 'due')?.label).toBe('Deadline');
    expect(change.migration).toBeNull();
  });

  it('renames a key in place, and says how the notes can follow', () => {
    const change = renameProperty(TASK, { key: 'due', newKey: 'deadline', label: '' });
    expect(keys(change.type)).toEqual(['status', 'deadline', 'owner', 'tags']);
    expect(property(change.type, 'deadline')?.label).toBe('Deadline');
    expect(change.migration).toEqual({ kind: 'renameKey', from: 'due', to: 'deadline' });
  });

  it('refuses a key another property has, or one that is not a name', () => {
    expect(() => renameProperty(TASK, { key: 'due', newKey: 'status', label: '' })).toThrow(
      /already a property/,
    );
    expect(() => renameProperty(TASK, { key: 'due', newKey: 'due date', label: '' })).toThrow(
      /letters, digits/,
    );
    expect(() => renameProperty(TASK, { key: 'nope', newKey: 'x', label: '' })).toThrow(
      /no property called "nope"/,
    );
  });

  it('removes one, offering to take its values out of the notes', () => {
    const change = removeProperty(TASK, 'owner');
    expect(keys(change.type)).toEqual(['status', 'due', 'tags']);
    expect(change.migration).toEqual({ kind: 'removeKey', key: 'owner' });
  });

  it('moves one to a position, clamped to the list', () => {
    expect(keys(moveProperty(TASK, { key: 'tags', to: 0 }))).toEqual([
      'tags',
      'status',
      'due',
      'owner',
    ]);
    expect(keys(moveProperty(TASK, { key: 'status', to: 99 }))).toEqual([
      'due',
      'owner',
      'tags',
      'status',
    ]);
  });

  it('toggles required', () => {
    expect(
      property(setPropertyRequired(TASK, { key: 'due', required: true }), 'due')?.required,
    ).toBe(true);
  });
});

describe('keys the type file has but cannot read (#683)', () => {
  const book = parseObjectType({
    name: 'book',
    label: 'Book',
    properties: { rating: 'number', author: { kind: 'relation', targets: 'person' } },
  });

  it('gives a new property a key of its own, never one the file holds unread', () => {
    const added = addProperty(book, { label: 'Author', kind: 'text' }).properties.at(-1);
    expect(added?.label).toBe('Author');
    expect(added?.key).not.toBe('author');
    expect(added?.key).toMatch(/^author/);
  });

  it('names a new property clear of one the file holds unread', () => {
    const placeholder = addProperty(book, { label: NEW_PROPERTY_LABEL });
    const key = placeholder.properties.at(-1)?.key ?? '';
    const named = renameProperty(placeholder, { key, newKey: key, label: 'Author' }).type;
    expect(named.properties.at(-1)?.key).not.toBe('author');
  });

  it('refuses to rename a property onto a key the file holds unread, and says why', () => {
    expect(() =>
      renameProperty(book, { key: 'rating', newKey: 'author', label: 'Author' }),
    ).toThrowError(
      new TypeEditError(
        '"author" is already in the type file, as a property DFAI cannot read: mend or remove it there first',
      ),
    );
    // Told the same, whatever its case: the file's key is what is in the way.
    expect(() =>
      renameProperty(book, { key: 'rating', newKey: 'Author', label: 'Author' }),
    ).toThrowError(/"author" is already in the type file, as a property DFAI cannot read/);
  });
});

describe('changing a kind', () => {
  it('keeps the options between the two select kinds, and many follows multiSelect', () => {
    const multi = changePropertyKind(TASK, { key: 'status', kind: 'multiSelect' });
    expect(property(multi, 'status')).toMatchObject({
      options: TASK.properties[0]?.options,
      many: true,
    });
    const single = changePropertyKind(multi, { key: 'status', kind: 'select' });
    expect(property(single, 'status')?.many).toBe(false);
  });

  it('drops options and colours when the kind has none', () => {
    const coloured = setOptionColor(TASK, { key: 'status', option: 'next', tone: 'done' });
    const text = property(changePropertyKind(coloured, { key: 'status', kind: 'text' }), 'status');
    expect(text?.options).toEqual([]);
    expect(text?.colors).toBeUndefined();
  });

  it('gives a new relation a target, and takes it away again', () => {
    const relation = changePropertyKind(TASK, { key: 'due', kind: 'relation' });
    expect(property(relation, 'due')?.target).toBe('task');
    expect(
      property(changePropertyKind(relation, { key: 'due', kind: 'text' }), 'due')?.target,
    ).toBeNull();
  });

  it('leaves a property alone when the kind is the same', () => {
    expect(changePropertyKind(TASK, { key: 'due', kind: 'date' })).toEqual(TASK);
  });
});

describe('relations', () => {
  it('points at any type the vault has, or the type itself, one or many', () => {
    const books = setRelation(TASK, { key: 'owner', target: 'book', many: true, types: ['book'] });
    expect(property(books, 'owner')).toMatchObject({ target: 'book', many: true });
    const self = setRelation(TASK, { key: 'owner', target: 'task', many: false, types: [] });
    expect(property(self, 'owner')?.target).toBe('task');
  });

  it('refuses a target that does not exist, and a property that is not a relation', () => {
    expect(() =>
      setRelation(TASK, { key: 'owner', target: 'ghost', many: false, types: [] }),
    ).toThrow(/no type called "ghost"/);
    expect(() => setRelation(TASK, { key: 'due', target: 'task', many: false, types: [] })).toThrow(
      /not a relation/,
    );
  });
});

describe('options', () => {
  const statusOptions = (type: ObjectType) => property(type, 'status')?.options;

  it('adds one at the end, refusing a blank or a repeat', () => {
    expect(statusOptions(addOption(TASK, { key: 'status', option: ' blocked ' }))?.at(-1)).toBe(
      'blocked',
    );
    expect(() => addOption(TASK, { key: 'status', option: 'done' })).toThrow(/already has "done"/);
    expect(() => addOption(TASK, { key: 'status', option: '' })).toThrow(/needs a name/);
    expect(() => addOption(TASK, { key: 'due', option: 'x' })).toThrow(/no options/);
  });

  it('renames one where it stands, and says how the notes can follow', () => {
    const change = renameOption(TASK, { key: 'status', from: 'review', to: 'in review' });
    expect(statusOptions(change.type)).toEqual(['backlog', 'next', 'doing', 'in review', 'done']);
    expect(change.migration).toEqual({
      kind: 'renameOption',
      key: 'status',
      from: 'review',
      to: 'in review',
    });
  });

  it('keeps the colour a renamed option had from its old name', () => {
    const change = renameOption(TASK, { key: 'status', from: 'review', to: 'in review' });
    const status = property(change.type, 'status') ?? null;
    expect(optionColor(status, 'in review')).toBe('review');
    expect(status?.colors).toEqual({ 'in review': 'review' });
  });

  it('writes no colour when the new name already gives the same one', () => {
    const change = renameOption(TASK, { key: 'status', from: 'next', to: 'todo' });
    // `todo` would be backlog by name, and `next` was next, so it is kept.
    expect(property(change.type, 'status')?.colors).toEqual({ todo: 'next' });
    const same = renameOption(TASK, { key: 'status', from: 'backlog', to: 'todo' });
    expect(property(same.type, 'status')?.colors).toBeUndefined();
  });

  it('keeps the hue an option had from its value, so a rename does not recolour it', () => {
    const change = renameOption(TASK, { key: 'tags', from: 'a', to: 'Larkspur Payroll' });
    expect(property(change.type, 'tags')?.colors).toEqual({ 'Larkspur Payroll': hueOf('a') });
  });

  it('takes a palette hue as an option’s colour, and forgets it when set back', () => {
    const blue = setOptionColor(TASK, { key: 'tags', option: 'a', tone: 'blue' });
    expect(optionColor(property(blue, 'tags') ?? null, 'a')).toBe('blue');
    const reset = setOptionColor(blue, { key: 'tags', option: 'a', tone: hueOf('a') });
    expect(property(reset, 'tags')?.colors).toBeUndefined();
  });

  it('refuses to rename onto another option, or one that is not there', () => {
    expect(() => renameOption(TASK, { key: 'status', from: 'review', to: 'done' })).toThrow(
      /already has "done"/,
    );
    expect(() => renameOption(TASK, { key: 'status', from: 'nope', to: 'x' })).toThrow(/no "nope"/);
  });

  it('needs nothing from the notes when the name did not change', () => {
    expect(renameOption(TASK, { key: 'status', from: 'done', to: 'done' }).migration).toBeNull();
  });

  it('moves one, which is the order a board shows its columns in', () => {
    expect(statusOptions(moveOption(TASK, { key: 'status', option: 'done', to: 0 }))).toEqual([
      'done',
      'backlog',
      'next',
      'doing',
      'review',
    ]);
    expect(() => moveOption(TASK, { key: 'status', option: 'nope', to: 0 })).toThrow(/no "nope"/);
  });

  it('removes one and its colour', () => {
    const coloured = setOptionColor(TASK, { key: 'status', option: 'review', tone: 'done' });
    const removed = property(removeOption(coloured, { key: 'status', option: 'review' }), 'status');
    expect(removed?.options).toEqual(['backlog', 'next', 'doing', 'done']);
    expect(removed?.colors).toBeUndefined();
    expect(() => removeOption(TASK, { key: 'status', option: 'nope' })).toThrow(/no "nope"/);
  });

  it('colours one, and going back to the tone its name gives it forgets the choice', () => {
    const coloured = setOptionColor(TASK, { key: 'status', option: 'next', tone: 'doing' });
    expect(optionColor(property(coloured, 'status') ?? null, 'next')).toBe('doing');
    const reset = setOptionColor(coloured, { key: 'status', option: 'next', tone: 'next' });
    expect(property(reset, 'status')?.colors).toBeUndefined();
    expect(() => setOptionColor(TASK, { key: 'status', option: 'x', tone: null })).toThrow(
      /no "x"/,
    );
  });

  it('tones a status option by its name, and hashes any other property’s', () => {
    expect(optionColor({ key: 'status' }, 'done')).toBe('done');
    expect(optionColor({ key: 'stage' }, 'done')).toBe(hueOf('done'));
  });
});

describe('applyTypeEdit', () => {
  const types = { types: ['task', 'person', 'project'] };
  const apply = (edit: TypeEdit) => applyTypeEdit(TASK, edit, types);

  it.each<[TypeEdit, (type: ObjectType) => unknown, unknown]>([
    [{ kind: 'setLabel', label: 'Chore' }, (type) => type.label, 'Chore'],
    [{ kind: 'setIcon', icon: 'grid' }, (type) => type.icon, 'grid'],
    [{ kind: 'addProperty', label: 'Size' }, (type) => property(type, 'size')?.kind, 'text'],
    [
      { kind: 'addProperty', label: 'When', propertyKind: 'date' },
      (type) => property(type, 'when')?.kind,
      'date',
    ],
    [{ kind: 'moveProperty', key: 'tags', to: 0 }, (type) => keys(type)[0], 'tags'],
    [
      { kind: 'changeKind', key: 'due', propertyKind: 'text' },
      (type) => property(type, 'due')?.kind,
      'text',
    ],
    [
      { kind: 'setRequired', key: 'due', required: true },
      (type) => property(type, 'due')?.required,
      true,
    ],
    [
      { kind: 'setRelation', key: 'owner', target: 'project', many: true },
      (type) => property(type, 'owner')?.target,
      'project',
    ],
    [
      { kind: 'addOption', key: 'tags', option: 'c' },
      (type) => property(type, 'tags')?.options,
      ['a', 'b', 'c'],
    ],
    [
      { kind: 'moveOption', key: 'tags', option: 'b', to: 0 },
      (type) => property(type, 'tags')?.options,
      ['b', 'a'],
    ],
    [
      { kind: 'removeOption', key: 'tags', option: 'a' },
      (type) => property(type, 'tags')?.options,
      ['b'],
    ],
    [
      { kind: 'setOptionColor', key: 'tags', option: 'a', tone: 'done' },
      (type) => property(type, 'tags')?.colors,
      { a: 'done' },
    ],
  ])('makes %j without anything for the notes to do', (edit, read, expected) => {
    const change = apply(edit);
    expect(read(change.type)).toEqual(expected);
    expect(change.migration).toBeNull();
  });

  it.each<[TypeEdit, unknown]>([
    [
      { kind: 'renameProperty', key: 'due', newKey: 'deadline', label: 'Deadline' },
      { kind: 'renameKey', from: 'due', to: 'deadline' },
    ],
    [
      { kind: 'removeProperty', key: 'due' },
      { kind: 'removeKey', key: 'due' },
    ],
    [
      { kind: 'renameOption', key: 'status', from: 'next', to: 'soon' },
      { kind: 'renameOption', key: 'status', from: 'next', to: 'soon' },
    ],
  ])('makes %j and says how the notes can follow', (edit, migration) => {
    expect(apply(edit).migration).toEqual(migration);
  });

  it('checks a relation target against the types it is given', () => {
    expect(() =>
      applyTypeEdit(
        TASK,
        { kind: 'setRelation', key: 'owner', target: 'project', many: false },
        {
          types: [],
        },
      ),
    ).toThrow(/no type called "project"/);
  });
});

describe('a type has at most one thumbnail', () => {
  const pictured = addProperty(TASK, { label: 'Art', kind: 'thumbnail' });

  it('refuses a second thumbnail property, added or changed into one', () => {
    // Only the first fronts a card (`thumbnailPropertyOf`); a second would be
    // a property that looks as if it does something and never does.
    expect(() => addProperty(pictured, { label: 'Cover', kind: 'thumbnail' })).toThrow(
      TypeEditError,
    );
    expect(() => changePropertyKind(pictured, { key: 'status', kind: 'thumbnail' })).toThrow(
      /already has a thumbnail/,
    );
  });

  it('lets the one thumbnail stay one, and a type without one gain one', () => {
    expect(changePropertyKind(pictured, { key: 'art', kind: 'thumbnail' })).toEqual(pictured);
    const changed = changePropertyKind(TASK, { key: 'status', kind: 'thumbnail' });
    expect(changed.properties.find((property) => property.key === 'status')?.kind).toBe(
      'thumbnail',
    );
  });
});
