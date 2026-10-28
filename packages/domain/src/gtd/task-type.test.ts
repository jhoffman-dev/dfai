import { describe, expect, it } from 'vitest';
import { parseObjectType, type ObjectType } from '../types/property-def.ts';
import { statusOf } from '../types/status-property.ts';
import { GTD_STATUSES } from './gtd-status.ts';
import {
  capturedTaskStatus,
  followsGtd,
  GTD_STATUS_PROPERTY,
  TASK_TYPE_FILE,
  taskTypeChange,
  taskTypeLines,
  taskTypeOf,
  tasksStartInInbox,
} from './task-type.ts';

/** P30-02: the built-in Task type, and what a vault's own becomes. */

/** This repository's own Task type, as `vault/.atlas/types/task.md` declares it. */
const OLD_TASK: ObjectType = parseObjectType({
  name: 'task',
  label: 'Task',
  properties: {
    status: {
      kind: 'select',
      options: ['backlog', 'next', 'doing', 'review', 'done'],
      done: 'done',
      required: true,
      colors: { review: 'review', backlog: 'next' },
    },
    phase: 'number',
    estimate: 'text',
    source: 'text',
    due: 'date',
    project: { kind: 'relation', target: 'project' },
  },
});

describe('the built-in Task type', () => {
  it('has exactly the eight statuses, in order, finished by Archive', () => {
    const status = statusOf(TASK_TYPE_FILE.type);
    expect(status).toEqual({ key: 'status', done: 'archive', options: [...GTD_STATUSES] });
    expect(GTD_STATUSES).toEqual([
      'inbox',
      'backlog',
      'next-action',
      'in-progress',
      'waiting',
      'someday',
      'longterm',
      'archive',
    ]);
  });

  it('waits on a person, and is filed under a project or an area', () => {
    const byKey = new Map(TASK_TYPE_FILE.type.properties.map((p) => [p.key, p]));
    expect(byKey.get('waiting_on')).toMatchObject({ kind: 'relation', target: 'person' });
    expect(byKey.get('project')).toMatchObject({ targets: ['project', 'area'] });
    expect(byKey.get('contexts')?.kind).toBe('multiSelect');
    expect(byKey.get('defer')?.kind).toBe('date');
    expect(byKey.get('completed')?.kind).toBe('date');
    expect(byKey.get('estimate')?.kind).toBe('number');
  });

  it('links back to the meeting a task was taken from, and keeps that item’s key (ADR-0036)', () => {
    const byKey = new Map(TASK_TYPE_FILE.type.properties.map((p) => [p.key, p]));
    expect(byKey.get('meeting')).toMatchObject({
      kind: 'relation',
      target: 'meeting',
      many: false,
    });
    expect(byKey.get('atlas_item')?.kind).toBe('text');
  });
});

describe('taskTypeChange', () => {
  it('gives an old Task type the eight statuses, keeping its own label, required and surviving tones', () => {
    const change = taskTypeChange(OLD_TASK);
    const status = change?.after.properties.find((p) => p.key === 'status');
    expect(status).toMatchObject({ options: [...GTD_STATUSES], done: 'archive', required: true });
    expect(status?.colors).toEqual({ backlog: 'next' });
    expect(change?.statusWas).toEqual(['backlog', 'next', 'doing', 'review', 'done']);
  });

  it('adds only the keys it lacks, and leaves the ones it has as they are', () => {
    const change = taskTypeChange(OLD_TASK)!;
    expect(change.added.map((p) => p.key)).toEqual([
      'waiting_on',
      'contexts',
      'defer',
      'completed',
    ]);
    const after = new Map(change.after.properties.map((p) => [p.key, p]));
    // Its own estimate stays text, and its own project still links projects alone.
    expect(after.get('estimate')?.kind).toBe('text');
    expect(after.get('project')).toEqual(OLD_TASK.properties.find((p) => p.key === 'project'));
    expect(after.get('phase')?.kind).toBe('number');
    expect(change.after.properties.slice(0, 6).map((p) => p.key)).toEqual(
      OLD_TASK.properties.map((p) => p.key),
    );
  });

  it('is nothing to do for a type that already follows GTD', () => {
    expect(taskTypeChange(TASK_TYPE_FILE.type)).toBeNull();
  });

  it('is nothing to do for a GTD type without `focus`: it is added on opening, not by the move (#108)', () => {
    expect(TASK_TYPE_FILE.type.properties.find((p) => p.key === 'focus')?.kind).toBe('date');
    const withoutFocus: ObjectType = {
      ...TASK_TYPE_FILE.type,
      properties: TASK_TYPE_FILE.type.properties.filter((p) => p.key !== 'focus'),
    };
    expect(taskTypeChange(withoutFocus)).toBeNull();
  });

  it('is nothing to do for a GTD type without the meeting keys: they are not the move to GTD’s (#177)', () => {
    const withoutMeetingKeys: ObjectType = {
      ...TASK_TYPE_FILE.type,
      properties: TASK_TYPE_FILE.type.properties.filter(
        (p) => p.key !== 'meeting' && p.key !== 'atlas_item',
      ),
    };
    expect(taskTypeChange(withoutMeetingKeys)).toBeNull();
  });

  it('adds a status, first, to a type with none', () => {
    const bare = parseObjectType({ name: 'task', properties: { due: 'date' } });
    const change = taskTypeChange(bare)!;
    expect(change.after.properties[0]?.key).toBe('status');
    expect(change.statusWas).toEqual([]);
  });

  it.each([
    ['in another order', [...GTD_STATUSES].reverse(), 'archive'],
    ['finished by something else', [...GTD_STATUSES], 'inbox'],
    ['missing one', GTD_STATUSES.slice(1), 'archive'],
  ])('moves a status %s to the eight', (_how, options, done) => {
    const type = {
      ...TASK_TYPE_FILE.type,
      properties: TASK_TYPE_FILE.type.properties.map((p) =>
        p.key === 'status' ? { ...p, options, done } : p,
      ),
    };
    expect(taskTypeChange(type)?.statusWas).toEqual(options);
  });
});

describe('taskTypeLines', () => {
  it('says what the status becomes and what it was, and what the type gains', () => {
    expect(taskTypeLines(taskTypeChange(OLD_TASK)!)).toEqual([
      'Status becomes Inbox, Backlog, Next Action, In Progress, Waiting, Someday, Longterm and Archive; ticking a task sets Archive (it was backlog, next, doing, review and done).',
      'Task gains Waiting on, Contexts, Defer until and Completed.',
    ]);
  });

  it('says only what changes', () => {
    const missingOne = {
      ...TASK_TYPE_FILE.type,
      properties: TASK_TYPE_FILE.type.properties.filter((p) => p.key !== 'defer'),
    };
    expect(taskTypeLines(taskTypeChange(missingOne)!)).toEqual(['Task gains Defer until.']);
    const bare = parseObjectType({ name: 'task', label: 'Chore', properties: {} });
    expect(taskTypeLines(taskTypeChange(bare)!)[0]).toMatch(/ticking a task sets Archive\.$/);
  });
});

describe('capturedTaskStatus', () => {
  it('starts a captured task in the Inbox when the Task type has it', () => {
    expect(capturedTaskStatus(TASK_TYPE_FILE.type)).toBe('inbox');
  });

  it('leaves a vault on statuses of its own, or without a Task type, to its template', () => {
    expect(capturedTaskStatus(OLD_TASK)).toBeNull();
    expect(capturedTaskStatus(null)).toBeNull();
    const elsewhere = parseObjectType({
      name: 'task',
      properties: { stage: { kind: 'select', options: ['inbox', 'done'], done: 'done' } },
    });
    expect(capturedTaskStatus(elsewhere)).toBeNull();
  });
});

describe('tasksStartInInbox', () => {
  it('is whether the vault’s Task type has the Inbox status', () => {
    expect(tasksStartInInbox([TASK_TYPE_FILE.type])).toBe(true);
    expect(tasksStartInInbox([OLD_TASK])).toBe(false);
    expect(tasksStartInInbox([])).toBe(false);
  });
});

describe('followsGtd', () => {
  const typeWith = (properties: ObjectType['properties']): ObjectType => ({
    name: 'task',
    label: 'Task',
    properties,
  });

  it('is true once the status is GTD’s eight, finished by Archive (P31-01)', () => {
    expect(followsGtd(TASK_TYPE_FILE.type)).toBe(true);
    expect(followsGtd(typeWith([GTD_STATUS_PROPERTY]))).toBe(true);
  });

  it('is false for statuses of the vault’s own, out of order, finished another way, or none', () => {
    const own = { ...GTD_STATUS_PROPERTY, options: ['backlog', 'done'], done: 'done' };
    const reordered = {
      ...GTD_STATUS_PROPERTY,
      options: [...GTD_STATUS_PROPERTY.options].reverse(),
    };
    const finishedElsewhere = { ...GTD_STATUS_PROPERTY, done: 'someday' };
    // Cases the Notion workspace importer's own copy of this check was tested on (#79).
    const noDone = Object.fromEntries(
      Object.entries(GTD_STATUS_PROPERTY).filter(([key]) => key !== 'done'),
    ) as typeof GTD_STATUS_PROPERTY;
    const multiSelect = { ...GTD_STATUS_PROPERTY, kind: 'multiSelect' as const };
    const anotherKey = { ...GTD_STATUS_PROPERTY, key: 'stage' };
    for (const status of [own, reordered, finishedElsewhere, noDone, multiSelect, anotherKey]) {
      expect(followsGtd(typeWith([status]))).toBe(false);
    }
    expect(followsGtd(typeWith([]))).toBe(false);
  });
});

describe('taskTypeOf', () => {
  it('finds the vault’s Task type by its name in any case and spacing, or none', () => {
    const project: ObjectType = { name: 'project', label: 'Project', properties: [] };
    const own: ObjectType = { name: ' Task ', label: 'Task', properties: [] };
    expect(taskTypeOf([project, own])).toBe(own);
    expect(taskTypeOf([project])).toBeNull();
    expect(taskTypeOf([])).toBeNull();
  });
});
