import { describe, expect, it } from 'vitest';
import { GTD_STATUS_PROPERTY, TASK_TYPE_FILE } from '../gtd/task-type.ts';
import { isBuiltInType, typeDeleteRefusal } from '../types/built-in-types.ts';
import { relationTypes, type ObjectType } from '../types/property-def.ts';
import {
  BLOCK_KEYS,
  BLOCK_TYPE_FILE,
  blockTypeOf,
  blockTypeToWrite,
  isBlockType,
} from './block-type.ts';

/** P31-01: the Block type timeblocks are notes of (ADR-0030). */
const typeNamed = (name: string): ObjectType => ({ name, label: name, properties: [] });

describe('the Block type', () => {
  const property = (key: string) =>
    BLOCK_TYPE_FILE.type.properties.find((candidate) => candidate.key === key);

  it('has a start and an end, both required, and links many tasks', () => {
    expect(property(BLOCK_KEYS.start)).toMatchObject({ kind: 'date', required: true });
    expect(property(BLOCK_KEYS.end)).toMatchObject({ kind: 'date', required: true });
    const tasks = property(BLOCK_KEYS.tasks);
    expect(tasks).toMatchObject({ kind: 'relation', many: true });
    expect(tasks === undefined ? [] : relationTypes(tasks)).toEqual(['task']);
  });

  it('keeps the Google event it is synced with', () => {
    expect(property('gcal_event_id')).toMatchObject({ kind: 'text' });
    expect(property('gcal_etag')).toMatchObject({ kind: 'text' });
    expect(property('gcal_calendar')).toMatchObject({ kind: 'text' });
    expect(property('gcal_missing')).toMatchObject({ kind: 'checkbox' });
    expect(property('gcal_synced_title')).toMatchObject({ kind: 'text' });
    expect(property('gcal_synced_start')).toMatchObject({ kind: 'text' });
    expect(property('gcal_synced_end')).toMatchObject({ kind: 'text' });
  });

  it('is built in: it cannot be deleted, and says why', () => {
    expect(isBuiltInType('block')).toBe(true);
    expect(typeDeleteRefusal({ name: 'block', label: 'Block' })).toContain(
      'timeblocks on the calendar are notes of it',
    );
  });
});

describe('blockTypeToWrite', () => {
  const ownTask: ObjectType = {
    name: 'task',
    label: 'Task',
    properties: [{ ...GTD_STATUS_PROPERTY, options: ['backlog', 'next', 'done'], done: 'done' }],
  };

  it('writes the Block type into a vault whose tasks follow GTD', () => {
    expect(blockTypeToWrite([TASK_TYPE_FILE.type])).toBe(BLOCK_TYPE_FILE);
    const gtdStatusOnly = { name: 'Task', label: 'Task', properties: [GTD_STATUS_PROPERTY] };
    expect(blockTypeToWrite([gtdStatusOnly, typeNamed('project')])).toBe(BLOCK_TYPE_FILE);
  });

  it('writes nothing into a vault on task statuses of its own, or with no tasks', () => {
    expect(blockTypeToWrite([ownTask])).toBeNull();
    expect(blockTypeToWrite([typeNamed('task')])).toBeNull();
    expect(blockTypeToWrite([])).toBeNull();
    expect(blockTypeToWrite([typeNamed('project')])).toBeNull();
  });

  it('never writes over a Block type the vault has, in any case', () => {
    expect(blockTypeToWrite([TASK_TYPE_FILE.type, typeNamed('block')])).toBeNull();
    expect(blockTypeToWrite([TASK_TYPE_FILE.type, typeNamed('Block')])).toBeNull();
  });
});

describe('which type is the Block type (P31-02)', () => {
  it('is the type named block, in any case, as its file is found', () => {
    expect(isBlockType('block')).toBe(true);
    expect(isBlockType(' Block ')).toBe(true);
    expect(isBlockType('blocks')).toBe(false);
    expect(isBlockType(null)).toBe(false);
    expect(isBlockType(undefined)).toBe(false);
  });

  it('is the vault’s own when it has one, labelled as it chose, else the built-in one', () => {
    const own: ObjectType = { name: 'Block', label: 'Focus time', properties: [] };

    expect(blockTypeOf([typeNamed('task'), own])).toBe(own);
    expect(blockTypeOf([typeNamed('task')])).toBe(BLOCK_TYPE_FILE.type);
  });
});
