import { describe, expect, it } from 'vitest';
import { parseObjectType } from '../types/property-def.ts';
import { newViewProblems } from './new-view.ts';
import { checkViewSpec } from './view-spec.ts';

const TYPES = [
  parseObjectType({
    name: 'task',
    label: 'Task',
    properties: { status: { kind: 'select', options: ['inbox', 'done'] }, due: 'date' },
  }),
  parseObjectType({ name: 'term', label: 'Term', properties: { kind: 'text' } }),
];

describe('checkViewSpec', () => {
  it('passes a name, a type the vault has and a layout it can draw', () => {
    expect(
      checkViewSpec({ name: ' Open tasks ', type: 'task', layout: 'board' }, { types: TYPES }),
    ).toEqual({ ok: true, request: { name: 'Open tasks', type: 'task', layout: 'board' } });
  });

  it('refuses each field in the New view dialog’s words, at that field', () => {
    const asked = { name: 'a/b', type: 'term', layout: 'board' as const };
    const reading = checkViewSpec(asked, { types: TYPES });

    expect(reading).toEqual({
      ok: false,
      problems: [
        { at: 'name', message: 'A view’s name cannot hold / \\ : * ? " < > or |.' },
        { at: 'layout', message: 'A board needs a property to group by, and Term has none.' },
      ],
    });
    // Verbatim: the dialog's own list says the same, in the same order.
    expect(reading.ok ? [] : reading.problems.map(({ message }) => message)).toEqual(
      newViewProblems(asked, { types: TYPES, takenPaths: [] }),
    );
  });

  it.each([
    [{ name: 'Deals', type: 'deal', layout: 'table' }, 'type', 'That type no longer exists.'],
    [{ name: 'Deals', type: ' ', layout: 'table' }, 'type', 'Choose a type.'],
    [{ name: 'Deals', type: 'task', layout: 'pie' }, 'layout', 'There is no layout called “pie”.'],
    [
      { name: 'Due', type: 'term', layout: 'calendar' },
      'layout',
      'A calendar needs a date, and Term has no date property.',
    ],
  ])('refuses %j at %s', (spec, at, message) => {
    expect(checkViewSpec(spec, { types: TYPES })).toEqual({
      ok: false,
      problems: [{ at, message }],
    });
  });

  it('says which fields are not text before checking any', () => {
    expect(checkViewSpec({ name: 3, layout: ['table'] }, { types: TYPES })).toEqual({
      ok: false,
      problems: [
        { at: 'name', message: 'name must be text.' },
        { at: 'type', message: 'type must be text.' },
        { at: 'layout', message: 'layout must be text.' },
      ],
    });
  });

  it('does not refuse a name already taken: it is numbered past when written', () => {
    expect(
      checkViewSpec({ name: 'All tasks', type: 'task', layout: 'table' }, { types: TYPES }).ok,
    ).toBe(true);
  });
});

describe('checkViewSpec and invisible characters', () => {
  it('refuses a name holding a bidirectional or zero-width character', () => {
    expect(
      checkViewSpec({ name: 'Open‏ tasks', type: 'task', layout: 'table' }, { types: TYPES }),
    ).toEqual({
      ok: false,
      problems: [
        { at: 'name', message: 'A view’s name cannot hold an invisible formatting character.' },
      ],
    });
  });
});
