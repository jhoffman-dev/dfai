import { describe, expect, it } from 'vitest';
import type { PropertyDef } from '../types/property-def.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { quickAddFields, quickAddBeside, quickAddProperties } from './quick-add-note.ts';

const property = (key: string, kind: PropertyDef['kind'], extra: Partial<PropertyDef> = {}) =>
  ({
    key,
    kind,
    label: key,
    required: false,
    options: [],
    target: null,
    many: false,
    ...extra,
  }) satisfies PropertyDef;

const STATUS = property('status', 'select', { options: ['backlog', 'doing'], required: true });
const PHASE = property('phase', 'number');
const PROJECT = property('project', 'relation', { target: 'project' });
const DUE = property('due', 'date');
const SCHEDULED = property('scheduled', 'date');
const PRIORITY = property('priority', 'select', { options: ['high', 'low'] });

describe('quickAddFields', () => {
  it('asks a task for its status, its project and its due date', () => {
    const task = { properties: [STATUS, PHASE, DUE, SCHEDULED, PROJECT] };
    expect(quickAddFields(task).map((field) => field.key)).toEqual(['status', 'project', 'due']);
  });

  it('asks for what is required first, then the first choice, then links, then the first date', () => {
    const owner = property('owner', 'text', { required: true });
    const type = { properties: [DUE, PROJECT, PRIORITY, owner] };
    expect(quickAddFields(type).map((field) => field.key)).toEqual([
      'owner',
      'priority',
      'project',
    ]);
  });

  it('asks for only the first choice when a type has several', () => {
    const type = { properties: [PRIORITY, property('size', 'select', { options: ['s'] })] };
    expect(quickAddFields(type).map((field) => field.key)).toEqual(['priority']);
  });

  it('asks for nothing but the title when a type has nothing worth asking', () => {
    expect(quickAddFields({ properties: [PHASE, property('notes', 'text')] })).toEqual([]);
  });

  it('never asks for more than three', () => {
    const relations = ['a', 'b', 'c', 'd'].map((key) =>
      property(key, 'relation', { target: 'person' }),
    );
    expect(quickAddFields({ properties: relations })).toHaveLength(3);
  });
});

describe('quickAddProperties', () => {
  it('writes the type and every field filled in, and nothing for an empty one', () => {
    expect(
      quickAddProperties({
        type: { name: 'task' },
        fields: [STATUS, PROJECT, DUE],
        values: { status: 'doing', project: ' ', due: '2026-10-01' },
      }),
    ).toEqual({ type: 'task', status: 'doing', due: '2026-10-01' });
  });

  it('writes only the fields asked for', () => {
    expect(
      quickAddProperties({ type: { name: 'task' }, fields: [DUE], values: { phase: '3' } }),
    ).toEqual({ type: 'task' });
  });

  it('never lets a field overwrite the type', () => {
    const field = property('type', 'text');
    expect(
      quickAddProperties({ type: { name: 'task' }, fields: [field], values: { type: 'book' } }),
    ).toEqual({ type: 'task' });
  });

  it('stores each value as its kind does', () => {
    const people = property('people', 'relation', { target: 'person', many: true });
    const tags = property('tags', 'multiSelect', { options: ['a', 'b'] });
    expect(
      quickAddProperties({
        type: { name: 'task' },
        fields: [PHASE, people, tags],
        values: { phase: '3', people: '[[Ada]]', tags: 'a, b' },
      }),
    ).toEqual({ type: 'task', phase: 3, people: ['[[Ada]]'], tags: ['a', 'b'] });
  });

  it('keeps a number that does not read as one as it was typed', () => {
    expect(
      quickAddProperties({ type: { name: 'task' }, fields: [PHASE], values: { phase: 'soon' } }),
    ).toEqual({ type: 'task', phase: 'soon' });
  });

  it('stores a ticked checkbox as true, not as the text "true"', () => {
    const signed = property('signed', 'checkbox', { required: true });
    expect(
      quickAddProperties({ type: { name: 'task' }, fields: [signed], values: { signed: 'true' } }),
    ).toEqual({ type: 'task', signed: true });
  });

  it('never stores an empty choice from a stray comma in a multi-select', () => {
    const tags = property('tags', 'multiSelect', { options: ['a', 'b'] });
    expect(
      quickAddProperties({ type: { name: 'task' }, fields: [tags], values: { tags: 'a,, b,' } }),
    ).toEqual({ type: 'task', tags: ['a', 'b'] });
  });

  it('keeps a multi-select choice typed in quotes whole, comma and all (#50)', () => {
    const clients = property('clients', 'multiSelect', { required: true });
    expect(
      quickAddProperties({
        type: { name: 'task' },
        fields: [clients],
        values: { clients: '"Payroll, Larkspur", Quill' },
      }),
    ).toEqual({ type: 'task', clients: ['Payroll, Larkspur', 'Quill'] });
  });
});

describe('quickAddBeside', () => {
  const acme = createVaultPath('Clients/Acme.md');

  it('puts a task with no home folder beside the note in view, as capture once did', () => {
    expect(quickAddBeside({ type: { name: 'task' }, beside: acme })).toBe(acme);
    expect(quickAddBeside({ type: { name: 'task' }, beside: null })).toBeNull();
  });

  it('puts any other type beside nothing, whatever is in view', () => {
    expect(quickAddBeside({ type: { name: 'project' }, beside: acme })).toBeNull();
  });
});
