import { describe, expect, it } from 'vitest';
import type { TaskCandidate } from '../gtd/task-similarity.ts';
import { addressesIn, type PersonCandidate } from '../people/person-match.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import type { AssistItemAnswer, AssistPersonAnswer } from './assist-answer.ts';
import { assistDuplicate } from './assist-duplicate.ts';
import { assistHeld } from './assist-held.ts';
import { assistPeople } from './assist-people.ts';
import { inboxItem } from './inbox.ts';

/**
 * Second attack on #906 (PR #907), at 28f945e1. Slice 3 acts on planned lines
 * unattended: it links a person, adds one, or archives the newer copy of a
 * duplicate after carrying over what `newerHolds` names. Each test is a line
 * planned that the item's own text, or what the item holds, does not support.
 */

const person = (path: string, name: string, aliases: string[] = [], emails: string[] = []) => ({
  path: createVaultPath(path),
  name,
  emails,
  aliases,
});
const WILL: PersonCandidate = person('People/Will Hollis.md', 'Will Hollis', ['Will']);
const MAY: PersonCandidate = person('People/May.md', 'May');

function planPeople(text: string, named: AssistPersonAnswer[], directory: PersonCandidate[]) {
  return assistPeople(named, {
    offered: directory.map((each) => ({ path: each.path, title: each.name })),
    directory,
    text,
    addresses: addressesIn(text),
    listed: null,
    takenTitles: new Set(),
  });
}

describe('attack2-907: people the text does not name', () => {
  it('does not link a person whose alias is a common word the item uses in lower case', () => {
    const planned = planPeople(
      'Renew Larkspur contract\nI will call them on Friday.\n',
      [{ name: 'Will', email: null, person: WILL.path }],
      [WILL],
    );
    expect(planned).not.toEqual({
      steps: [{ kind: 'link', person: { path: WILL.path, title: WILL.name } }],
    });
  });

  it('does not link a person whose one-word name the item uses only as a common word', () => {
    const planned = planPeople(
      'Renew Larkspur contract\nmaybe in may\n',
      [{ name: 'May', email: null, person: MAY.path }],
      [MAY],
    );
    expect(planned).not.toEqual({
      steps: [{ kind: 'link', person: { path: MAY.path, title: MAY.name } }],
    });
  });

  it('does not add a person whose name the item gives only inside an address', () => {
    const planned = planPeople(
      'Forward the invoice\nping tobias.fenn@example.com\n',
      [{ name: 'Tobias Fenn', email: 'tobias.fenn@example.com', person: null }],
      [],
    );
    expect('question' in planned).toBe(true);
  });
});

const ITEM = createVaultPath('Inbox/Renew Larkspur contract.md');
const task = (extra: Partial<TaskCandidate> = {}): TaskCandidate => ({
  path: createVaultPath('Tasks/Renew Larkspur contract.md'),
  title: 'Renew Larkspur contract',
  project: null,
  status: 'next-action',
  due: null,
  recurrence: null,
  waitingOn: '',
  ...extra,
});
const answer: AssistItemAnswer = {
  item: ITEM,
  kind: 'task',
  projects: [],
  due: null,
  waitingOn: null,
  confidence: 'high',
  why: 'The same renewal.',
  duplicateOf: task().path,
  people: [],
};
function duplicateOf(row: Record<string, unknown>, candidate: TaskCandidate) {
  const item = inboxItem({ path: ITEM, title: 'Renew Larkspur contract', type: 'task', ...row });
  return {
    held: assistHeld(item),
    line: assistDuplicate({
      answer,
      held: assistHeld(item),
      filing: null,
      candidates: [{ task: candidate, likeness: 'same-title' }],
      inboxTwin: null,
      listedPeople: null,
      hasBody: false,
    }),
  };
}

describe('attack2-907: a duplicate line never under-claims what the newer copy holds', () => {
  it('names a defer date the newer copy holds and the older lacks', () => {
    const { line } = duplicateOf({ defer: '2026-12-01' }, task());
    expect(line).toMatchObject({ kind: 'duplicate' });
    expect(line !== null && 'newerHolds' in line ? line.newerHolds : []).not.toEqual([]);
  });

  it('never plans a silent duplicate when the copies wait on different people', () => {
    const { held, line } = duplicateOf(
      { status: 'waiting', waitingOn: 'People/Mara Quill.md', waitingOnNames: 'Mara Quill' },
      task({ status: 'waiting', waitingOn: 'Tobias Fenn' }),
    );
    expect(held.waitingOn).not.toBeNull();
    const silent =
      line !== null && line.kind === 'duplicate' && !line.newerHolds.includes('waitingOn');
    expect(silent).toBe(false);
  });
});
