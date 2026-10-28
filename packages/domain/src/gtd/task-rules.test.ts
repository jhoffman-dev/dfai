import { describe, expect, it } from 'vitest';
import { taskRuleChanges } from './task-rules.ts';

/** P30-02: the rules every change to a task is held to (ADR-0029). */
const TODAY = '2026-10-08';
const rule = (before: Record<string, unknown>, changes: Record<string, unknown>) =>
  taskRuleChanges({ before, changes, today: TODAY });

describe('Waiting never needs someone to wait on (#202)', () => {
  it('moves a task to Waiting with nobody to wait on, as any status', () => {
    expect(rule({ type: 'task', status: 'next-action' }, { status: 'waiting' })).toEqual({
      changes: { status: 'waiting' },
    });
    expect(
      rule({ type: 'task', status: 'next-action', waiting_on: '' }, { status: 'waiting' }),
    ).toEqual({ changes: { status: 'waiting' } });
    expect(
      rule({ type: 'task', status: 'next-action', waiting_on: [] }, { status: 'waiting' }),
    ).toEqual({ changes: { status: 'waiting' } });
  });

  it('writes who it waits on when the change names them, before or in the same change', () => {
    const before = { type: 'task', status: 'next-action', waiting_on: '[[Mara Quill]]' };
    expect(rule(before, { status: 'waiting' })).toEqual({ changes: { status: 'waiting' } });
    const both = { status: 'waiting', waiting_on: '[[Tobias Fenn]]' };
    expect(rule({ type: 'task', status: 'inbox' }, both)).toEqual({ changes: both });
  });

  it('takes the person away from a task still waiting', () => {
    const before = { type: 'task', status: 'waiting', waiting_on: '[[Mara Quill]]' };
    expect(rule(before, { waiting_on: null })).toEqual({ changes: { waiting_on: null } });
  });

  it('leaves other changes to a task already waiting on nobody alone', () => {
    expect(rule({ type: 'task', status: 'waiting' }, { due: '2026-10-09' })).toEqual({
      changes: { due: '2026-10-09' },
    });
  });

  it('makes a note that says Waiting a task, with nobody to wait on', () => {
    expect(rule({ status: 'next-action' }, { type: 'task', status: 'waiting' })).toEqual({
      changes: { type: 'task', status: 'waiting' },
    });
  });

  it('is the same for a note that is not a task', () => {
    expect(rule({ type: 'project', status: 'active' }, { status: 'waiting' })).toEqual({
      changes: { status: 'waiting' },
    });
  });
});

describe('finishing a task is a day', () => {
  it('dates a task moved to Archive with today', () => {
    expect(rule({ type: 'task', status: 'in-progress' }, { status: 'archive' })).toEqual({
      changes: { status: 'archive', completed: TODAY },
    });
  });

  it('keeps a day the change says, or the task already holds', () => {
    expect(
      rule({ type: 'task', status: 'next-action' }, { status: 'archive', completed: '2026-10-01' }),
    ).toEqual({ changes: { status: 'archive', completed: '2026-10-01' } });
    expect(
      rule({ type: 'task', status: 'next-action', completed: '2026-10-01' }, { status: 'archive' }),
    ).toEqual({ changes: { status: 'archive' } });
  });

  it('takes the day away when the task leaves the Archive', () => {
    expect(
      rule({ type: 'Task', status: 'archive', completed: '2026-10-01' }, { status: 'next-action' }),
    ).toEqual({ changes: { status: 'next-action', completed: null } });
  });

  it('writes nothing more when the status does not move', () => {
    expect(rule({ type: 'task', status: 'archive' }, { status: 'archive' })).toEqual({
      changes: { status: 'archive' },
    });
    expect(rule({ type: 'task', status: 'inbox' }, { status: 'backlog' })).toEqual({
      changes: { status: 'backlog' },
    });
  });
});

describe('a status in another spelling (round 2)', () => {
  it('is written as the GTD status itself, and held to its rules', () => {
    expect(rule({ type: 'task', status: 'inbox' }, { status: [' next-action'] })).toEqual({
      changes: { status: 'next-action' },
    });
    expect(rule({ type: 'task', status: 'inbox' }, { status: 'archive ' })).toEqual({
      changes: { status: 'archive', completed: TODAY },
    });
    expect(rule({ type: 'task', status: 'inbox' }, { status: ['archive'] })).toEqual({
      changes: { status: 'archive', completed: TODAY },
    });
  });

  it('leaves a status no GTD spelling names, and a note that is not a task, as written', () => {
    expect(rule({ type: 'task', status: 'inbox' }, { status: ' Done ' })).toEqual({
      changes: { status: ' Done ' },
    });
    expect(rule({ type: 'project', status: 'active' }, { status: ['waiting'] })).toEqual({
      changes: { status: ['waiting'] },
    });
  });

  it('moves a task to Waiting on a list of blank names', () => {
    const changes = { status: 'waiting', waiting_on: ['', ' '] };
    expect(rule({ type: 'task', status: 'inbox' }, changes)).toEqual({ changes });
  });
});

describe('a status the note already holds in another spelling (round 2)', () => {
  it('is still Waiting when the person is taken away', () => {
    const before = { type: 'task', status: ['waiting'], waiting_on: '[[Mara Quill]]' };
    expect(rule(before, { waiting_on: null })).toEqual({ changes: { waiting_on: null } });
  });

  it('is still Archive, so leaving it takes the day away', () => {
    const before = { type: 'task', status: 'archive ', completed: '2026-10-01' };
    expect(rule(before, { status: 'next-action' })).toEqual({
      changes: { status: 'next-action', completed: null },
    });
  });
});

describe('finishing a task ends its choice for the day (#108)', () => {
  const chosen = { type: 'task', status: 'next-action', focus: '2026-10-08' };

  it('takes a dated focus out of a task that is finished', () => {
    expect(rule(chosen, { status: 'archive' })).toEqual({
      changes: { status: 'archive', completed: TODAY, focus: null },
    });
  });

  it('takes it out of a repeating task rolled on, which stays open', () => {
    const roll = { status: 'next-action', due: '2026-10-15', lastCompleted: '2026-10-08' };
    expect(rule({ ...chosen, recurrence: 'every week' }, roll)).toEqual({
      changes: { ...roll, focus: null },
    });
  });

  it('leaves a focus that is the person’s own, and a change that names focus itself', () => {
    const own = { type: 'task', status: 'next-action', focus: 'writing' };
    expect(rule(own, { status: 'archive' })).toEqual({
      changes: { status: 'archive', completed: TODAY },
    });
    expect(rule(chosen, { status: 'archive', focus: '2026-10-09' })).toEqual({
      changes: { status: 'archive', focus: '2026-10-09', completed: TODAY },
    });
  });

  it('leaves a task already finished, or one with no focus, as it was', () => {
    const done = { type: 'task', status: 'archive', completed: '2026-10-01', focus: '2026-10-01' };
    expect(rule(done, { due: '2026-10-09' })).toEqual({ changes: { due: '2026-10-09' } });
    expect(rule({ type: 'task', status: 'next-action' }, { status: 'archive' })).toEqual({
      changes: { status: 'archive', completed: TODAY },
    });
  });
});

describe('ending the day’s choice, exactly (#108, verification review)', () => {
  const chosen = { type: 'task', status: 'next-action', focus: '2026-10-08' };
  const repeating = { ...chosen, recurrence: 'every week', due: '2026-10-08' };

  it('leaves a blank focus key, as a property template writes it, when a task is finished', () => {
    for (const focus of ['', null]) {
      expect(rule({ ...chosen, focus }, { status: 'archive' })).toEqual({
        changes: { status: 'archive', completed: TODAY },
      });
    }
  });

  it('takes focus out of a real roll, which writes due and status with lastCompleted', () => {
    const roll = { due: '2026-10-15', status: 'next-action', lastCompleted: '2026-10-08' };
    expect(rule(repeating, roll)).toEqual({ changes: { ...roll, focus: null } });
  });

  it('keeps focus when lastCompleted alone is edited by hand', () => {
    expect(rule(repeating, { lastCompleted: '2026-10-01' })).toEqual({
      changes: { lastCompleted: '2026-10-01' },
    });
  });

  it('keeps focus when a finished task is reopened', () => {
    const done = { type: 'task', status: 'archive', completed: '2026-10-07', focus: '2026-10-08' };
    expect(rule(done, { status: 'next-action' })).toEqual({
      changes: { status: 'next-action', completed: null },
    });
  });
});
