import { describe, expect, it } from 'vitest';
import { seededRandom } from '../testing/hostile-text.ts';
import {
  isTaskPriority,
  priorityLabel,
  priorityName,
  TASK_PRIORITIES,
  taskPriorityOf,
} from './task-priority.ts';
import { taskRuleChanges } from './task-rules.ts';
import { ranksTasks, TASK_TYPE_FILE, taskTypeChange } from './task-type.ts';
import type { ObjectType, PropertyKind } from '../types/property-def.ts';

/** #913: a task's priority, 1 (the most urgent) to 4, or none (ADR-0029's addendum). */
const TODAY = '2026-11-18';
const TASK = { type: 'task', status: 'next-action' };
const rule = (changes: Record<string, unknown>, before: Record<string, unknown> = TASK) =>
  taskRuleChanges({ before, changes, today: TODAY });

describe('what a priority is', () => {
  it('is the integer 1, 2, 3 or 4, and nothing else', () => {
    expect(TASK_PRIORITIES).toEqual([1, 2, 3, 4]);
    for (const priority of TASK_PRIORITIES) expect(isTaskPriority(priority)).toBe(true);
    for (const other of [0, 5, 2.5, -1, Number.NaN, '1', 'high', null, true, [1]]) {
      expect(isTaskPriority(other)).toBe(false);
    }
  });

  it('reads back from the number or its digit as text, and is none otherwise', () => {
    expect(taskPriorityOf(2)).toBe(2);
    expect(taskPriorityOf('3')).toBe(3);
    expect(taskPriorityOf(' 4 ')).toBe(4);
    // A list of one reads as its item, as the index reads a one-item list.
    expect(taskPriorityOf([2])).toBe(2);
    expect(taskPriorityOf(['3'])).toBe(3);
    for (const none of [
      null,
      undefined,
      '',
      '0',
      '5',
      '2.5',
      '1x',
      'P1',
      'high',
      1.5,
      [1, 2],
      [[2]],
    ]) {
      expect(taskPriorityOf(none)).toBeNull();
    }
  });

  it('is labelled P1 to P4, and named in words for a screen reader', () => {
    expect(TASK_PRIORITIES.map(priorityLabel)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(priorityName(1)).toBe('Priority 1');
  });
});

describe('a soft field: the task rules write any priority as given (#913)', () => {
  it('writes 1 to 4, a value of the vault’s own, and none, exactly as sent', () => {
    for (const priority of [1, 4, 0, 5, 2.5, '2', 'high', [1, 2], null]) {
      expect(rule({ priority })).toEqual({ changes: { priority } });
    }
  });

  it('writes a new task’s own priority as given', () => {
    expect(rule({ type: 'task', priority: 'high' }, {})).toEqual({
      changes: { type: 'task', priority: 'high' },
    });
  });

  it('never refuses a change for its priority, whatever a seeded walk sends', () => {
    const random = seededRandom(913);
    const pieces = [0, 1, 2, 3, 4, 5, 2.5, -3, '1', '4', '07', 'high', '', null, true, ['2']];
    for (let step = 0; step < 300; step += 1) {
      const sent = pieces[Math.floor(random() * pieces.length)];
      expect(rule({ priority: sent })).toEqual({ changes: { priority: sent } });
    }
  });
});

describe('the built-in Task type', () => {
  it('declares priority as a number, after GTD’s keys', () => {
    const priority = TASK_TYPE_FILE.type.properties.find(({ key }) => key === 'priority');
    expect(priority).toMatchObject({ kind: 'number', label: 'Priority', required: false });
  });

  it('does not offer a vault already on GTD the move again for it', () => {
    expect(taskTypeChange(TASK_TYPE_FILE.type)).toBeNull();
    const withoutPriority = {
      ...TASK_TYPE_FILE.type,
      properties: TASK_TYPE_FILE.type.properties.filter(({ key }) => key !== 'priority'),
    };
    expect(taskTypeChange(withoutPriority)).toBeNull();
  });
});

const taskType = (kind?: PropertyKind): ObjectType => ({
  name: 'task',
  label: 'Task',
  properties:
    kind === undefined
      ? []
      : [{ ...TASK_TYPE_FILE.type.properties[0]!, key: 'priority', kind, options: [] }],
});

describe('ranksTasks: whether the vault’s tasks are ranked 1 to 4 (#913)', () => {
  it('is true when the Task type declares priority as a number, or not at all, or there is none', () => {
    expect(ranksTasks([])).toBe(true);
    expect(ranksTasks([taskType()])).toBe(true);
    expect(ranksTasks([taskType('number')])).toBe(true);
    expect(ranksTasks([TASK_TYPE_FILE.type])).toBe(true);
  });

  it('is false when the Task type keeps a priority of another kind', () => {
    for (const kind of ['select', 'text', 'multiSelect', 'date', 'checkbox'] as const) {
      expect(ranksTasks([taskType(kind)])).toBe(false);
    }
  });

  it('reads the Task type alone: another type’s priority does not count', () => {
    const goal = { ...taskType('select'), name: 'goal', label: 'Goal' };
    expect(ranksTasks([goal])).toBe(true);
  });
});
