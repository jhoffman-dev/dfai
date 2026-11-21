import { describe, expect, it } from 'vitest';
import type { TaskCandidate } from '../gtd/task-similarity.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import type { AssistItemAnswer } from './assist-answer.ts';
import { assistDuplicate } from './assist-duplicate.ts';
import { assistHeld, writtenPropertiesOf } from './assist-held.ts';
import { inboxItem } from './inbox.ts';

/**
 * #928: an Inbox copy of a task, both due on one day. The copies are the same
 * when they name the same time of day too, however it is written — no
 * needless carrying over — and differ, so the plan asks, when they part only
 * by the time.
 */
const ITEM = createVaultPath('Inbox/Call Mara Quill.md');
const kept = (dueTime?: string): TaskCandidate => ({
  path: createVaultPath('Tasks/Call Mara Quill.md'),
  title: 'Call Mara Quill',
  project: null,
  status: 'next-action',
  due: '2026-12-04',
  ...(dueTime !== undefined && { dueTime }),
  recurrence: null,
  waitingOn: '',
  dueUnread: false,
  defer: null,
  contexts: [],
  people: [],
});
const answer: AssistItemAnswer = {
  item: ITEM,
  kind: 'task',
  projects: [],
  due: null,
  waitingOn: null,
  confidence: 'high',
  why: 'The same call.',
  duplicateOf: kept().path,
  people: [],
};

function lineFor(due: string, candidate: TaskCandidate) {
  const item = inboxItem({
    path: ITEM,
    title: 'Call Mara Quill',
    type: 'task',
    status: 'inbox',
    due: due.slice(0, 10),
    dueWritten: due,
  });
  return assistDuplicate({
    answer,
    held: assistHeld(item),
    filing: null,
    candidates: [{ task: candidate, likeness: 'same-title' }],
    inboxTwin: null,
    listedPeople: null,
    hasBody: false,
    written: writtenPropertiesOf({ type: 'task', status: 'inbox', due }),
  });
}

describe('a duplicate of a task with a timed due (#928)', () => {
  it('is the same task when both name the same time, and carries no due over', () => {
    const line = lineFor('2026-12-04T15:30', kept('15:30'));
    expect(line).toMatchObject({ kind: 'duplicate' });
    expect(line !== null && line.kind === 'duplicate' && line.newerHolds).toEqual([]);
    // Written with a space, it is the same time still.
    const spaced = lineFor('2026-12-04 15:30', kept('15:30'));
    expect(spaced !== null && spaced.kind === 'duplicate' && spaced.newerHolds).toEqual([]);
  });

  it('is the same task when neither names a time', () => {
    const line = lineFor('2026-12-04', kept());
    expect(line !== null && line.kind === 'duplicate' && line.newerHolds).toEqual([]);
  });

  it('asks rather than plan a duplicate when they part only by the time', () => {
    expect(lineFor('2026-12-04T15:30', kept('09:00'))?.kind).not.toBe('duplicate');
    expect(lineFor('2026-12-04T15:30', kept())?.kind).not.toBe('duplicate');
    expect(lineFor('2026-12-04', kept('09:00'))?.kind).not.toBe('duplicate');
  });
});
