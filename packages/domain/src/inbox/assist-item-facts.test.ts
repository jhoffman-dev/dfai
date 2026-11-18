import { describe, expect, it } from 'vitest';
import type { TaskCandidate } from '../gtd/task-similarity.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { assistItemFacts, type AssistAsked } from './assist-item-facts.ts';
import { inboxItem } from './inbox.ts';

/**
 * #907: an asked item's own facts. Two captures in the Inbox are never each
 * other's kept copy; the newer of two is asked about, the older is not.
 */

const TITLE = 'Renew Larkspur Payroll contract';
const asked = (path: string, modified: number, text = 'Before December.\n'): AssistAsked => ({
  item: inboxItem({ path: createVaultPath(path), title: TITLE, type: null }),
  text,
  modified,
  listedPeople: null,
});
const task = (path: string, extra: Partial<TaskCandidate> = {}): TaskCandidate => ({
  path: createVaultPath(path),
  title: TITLE,
  project: null,
  status: 'next-action',
  due: null,
  recurrence: null,
  waitingOn: '',
  ...extra,
});

describe('assistItemFacts', () => {
  it('lists as possible duplicates only open tasks that are not Inbox items', () => {
    const one = asked('Inbox/Renew.md', 1);
    const elsewhere = asked('Projects/Renew draft.md', 1);
    const facts = assistItemFacts({
      asked: [one, elsewhere],
      tasks: [
        task('Tasks/Renew.md'),
        task('Inbox/Renew again.md'),
        task('Projects/Renew draft.md'),
        task('Tasks/Captured.md', { status: 'inbox' }),
      ],
    });
    expect(facts.get(one.item.path)!.duplicates.map((each) => each.task.path)).toEqual([
      'Tasks/Renew.md',
    ]);
  });

  it('asks on the newer of two captures, not the older; on both when they cannot be told apart', () => {
    const older = asked('Inbox/Renew.md', 1_000);
    const newer = asked('Inbox/Renew 1.md', 2_000);
    const facts = assistItemFacts({ asked: [older, newer], tasks: [] });
    expect(facts.get(older.item.path)!.inboxTwin).toBeNull();
    expect(facts.get(newer.item.path)!.inboxTwin).toBe(TITLE);
    const same = assistItemFacts({ asked: [older, { ...newer, modified: 1_000 }], tasks: [] });
    expect([...same.values()].map((each) => each.inboxTwin)).toEqual([TITLE, TITLE]);
  });

  it('reads the item’s words and addresses from its body, not its frontmatter', () => {
    const one = asked(
      'Inbox/Renew.md',
      1,
      '---\npeople: mara@example.com\n---\nAsk tobias@example.org\n',
    );
    const facts = assistItemFacts({ asked: [one], tasks: [] }).get(one.item.path)!;
    expect(facts.addresses).toEqual(['tobias@example.org']);
    expect(facts.text).toBe(`${TITLE}\nAsk tobias@example.org\n`);
    expect(facts.hasBody).toBe(true);
    const bare = assistItemFacts({ asked: [asked('Inbox/Renew.md', 1, '')], tasks: [] });
    expect([...bare.values()][0]!.hasBody).toBe(false);
  });
});
