import { describe, expect, it } from 'vitest';
import { seededRandom } from '../testing/hostile-text.ts';
import { TASK_KEYS } from './gtd-status.ts';
import {
  isTaskPriority,
  isTaskPriorityField,
  keepsTaskPriority,
  PRIORITY_REFUSAL,
  priorityLabel,
  priorityName,
  TASK_PRIORITIES,
  taskPriorityOf,
} from './task-priority.ts';
import { taskRuleChanges } from './task-rules.ts';
import { clarifyVocabulary, ranksTasks, TASK_TYPE_FILE, taskTypeChange } from './task-type.ts';
import type { ObjectType, PropertyKind } from '../types/property-def.ts';

/** #913: a task's priority, 1 (the most urgent) to 4, or none (ADR-0029's addendum). */
const TODAY = '2026-11-18';
const TASK = { type: 'task', status: 'next-action' };
const rule = (changes: Record<string, unknown>, before: Record<string, unknown> = TASK) =>
  taskRuleChanges({ before, changes, today: TODAY, holdsPriority: true });

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
    for (const none of [null, undefined, '', '0', '5', '2.5', '1x', 'P1', 'high', 1.5, [2]]) {
      expect(taskPriorityOf(none)).toBeNull();
    }
  });

  it('is labelled P1 to P4, and named in words for a screen reader', () => {
    expect(TASK_PRIORITIES.map(priorityLabel)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(priorityName(1)).toBe('Priority 1');
  });
});

describe('the task rules hold a priority to 1 to 4 (#913)', () => {
  it('writes each of the four as asked', () => {
    for (const priority of TASK_PRIORITIES) {
      expect(rule({ priority })).toEqual({ changes: { priority } });
    }
  });

  it('writes a digit given as text as the number, as a typed field hands it over', () => {
    expect(rule({ priority: '2' })).toEqual({ changes: { priority: 2 } });
  });

  it('takes the key out for none, whether it was sent as null or as a blank', () => {
    for (const none of [null, '', '  ', []]) {
      expect(rule({ priority: none }, { ...TASK, priority: 2 })).toEqual({
        changes: { priority: null },
      });
    }
  });

  it('refuses anything else, saying what a priority may be without echoing the value', () => {
    const bad = [0, 5, 2.5, -1, Number.NaN, Infinity, -Infinity, 'high', 'P1', true, [1, 2], {}];
    for (const value of bad)
      expect(rule({ priority: value })).toEqual({ refused: PRIORITY_REFUSAL });
    expect(PRIORITY_REFUSAL).toBe(
      'A task’s priority is a whole number from 1 (the most urgent) to 4, or none.',
    );
  });

  it('writes any value as given where the caller does not hold the change to it', () => {
    for (const value of ['high', 7, '2', [1, 2]]) {
      expect(taskRuleChanges({ before: TASK, changes: { priority: value }, today: TODAY })).toEqual(
        { changes: { priority: value } },
      );
    }
  });

  it('judges a note made a task by the same change', () => {
    expect(rule({ type: 'task', priority: 9 }, {})).toHaveProperty('refused');
    expect(rule({ type: 'task', priority: 1 }, {})).toEqual({
      changes: { type: 'task', priority: 1 },
    });
  });

  it('leaves a note that is not a task, and a change that does not name priority, alone', () => {
    expect(rule({ priority: 'high' }, { type: 'project' })).toEqual({
      changes: { priority: 'high' },
    });
    expect(rule({ status: 'waiting' }, { ...TASK, priority: 'high' })).toEqual({
      changes: { status: 'waiting' },
    });
  });

  it('holds every value a seeded walk sends to the rule: one of the four, none, or refused', () => {
    const random = seededRandom(913);
    const pieces = [0, 1, 2, 3, 4, 5, 2.5, -3, '1', '4', '07', 'high', '', null, true, ['2']];
    for (let step = 0; step < 500; step += 1) {
      const sent = pieces[Math.floor(random() * pieces.length)];
      const outcome = rule({ priority: sent });
      if ('refused' in outcome) {
        expect(taskPriorityOf(sent)).toBeNull();
        continue;
      }
      const written = outcome.changes[TASK_KEYS.priority];
      expect(written === null || isTaskPriority(written)).toBe(true);
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

describe('a vault whose Task type keeps a priority of its own (#913)', () => {
  it('ranks its tasks 1 to 4 only when the type keeps priority as a number, or not at all', () => {
    expect(keepsTaskPriority(null)).toBe(true);
    expect(keepsTaskPriority(taskType())).toBe(true);
    expect(keepsTaskPriority(taskType('number'))).toBe(true);
    for (const kind of ['select', 'text', 'multiSelect', 'date', 'checkbox'] as const) {
      expect(keepsTaskPriority(taskType(kind))).toBe(false);
    }
    expect(ranksTasks([])).toBe(true);
    expect(ranksTasks([taskType('select')])).toBe(false);
  });

  it('tells Clarify whether it may give a task a priority', () => {
    expect(clarifyVocabulary([]).ranks).toBe(true);
    expect(clarifyVocabulary([taskType('number')]).ranks).toBe(true);
    expect(clarifyVocabulary([taskType('select')]).ranks).toBe(false);
  });

  it('is a task’s 1-to-4 field only on the Task type, and only as a number', () => {
    const number = { key: 'priority', kind: 'number' } as const;
    expect(isTaskPriorityField({ typeName: 'task', def: number })).toBe(true);
    expect(isTaskPriorityField({ typeName: ' Task ', def: number })).toBe(true);
    expect(isTaskPriorityField({ typeName: 'goal', def: number })).toBe(false);
    expect(isTaskPriorityField({ typeName: null, def: number })).toBe(false);
    expect(isTaskPriorityField({ typeName: 'task', def: { ...number, kind: 'select' } })).toBe(
      false,
    );
    expect(isTaskPriorityField({ typeName: 'task', def: { ...number, key: 'rank' } })).toBe(false);
  });
});
