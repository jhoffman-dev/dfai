import { describe, expect, it } from 'vitest';
import type { AssistItemFacts } from '../inbox/assist-plan.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  INBOX_ASSIST_LISTED_MAX,
  inboxAssistData,
  inboxAssistOffered,
} from './inbox-assist-prompt.ts';

/**
 * #906: what Claude is handed to pick from is what its answer is checked
 * against, and it is bounded however large the vault is.
 */

const CALL = createVaultPath('Inbox/Call Mara Quill.md');
const LINK = createVaultPath('Inbox/Payroll article.md');
const RENEW = createVaultPath('Tasks/Renew Larkspur Payroll contract.md');
const own = (paths: string[]): AssistItemFacts => ({
  duplicates: paths.map((path) => ({
    task: { path: createVaultPath(path), title: path, project: null, status: null },
    likeness: 'same-title' as const,
  })),
  addresses: [],
  listedPeople: null,
});
const people = Array.from({ length: INBOX_ASSIST_LISTED_MAX + 5 }, (_, at) => ({
  path: createVaultPath(`People/Person ${at}.md`),
  title: `Person ${at}`,
}));
const FACTS = {
  filingTargets: [
    { path: createVaultPath('Projects/Larkspur Payroll.md'), title: 'Larkspur Payroll' },
  ],
  people,
  items: new Map([
    [CALL, own([RENEW])],
    [LINK, own([])],
  ]),
};

describe('inboxAssistOffered and inboxAssistData', () => {
  it('offers each item its own duplicates, and the people listed, no more', () => {
    const offered = inboxAssistOffered(FACTS);
    expect(offered.duplicates.get(CALL)).toEqual([RENEW]);
    expect(offered.duplicates.get(LINK)).toEqual([]);
    expect(offered.people).toHaveLength(INBOX_ASSIST_LISTED_MAX);
    expect(offered.people).not.toContain(people[INBOX_ASSIST_LISTED_MAX]!.path);
  });

  it('lists, as data, the projects, the people offered and each note’s possible duplicates', () => {
    const data = inboxAssistData(FACTS);
    expect(data.map((each) => each.about)).toEqual([
      'Projects and areas',
      'People',
      'Possible duplicates',
    ]);
    expect(data[1]!.text.split('\n')).toHaveLength(INBOX_ASSIST_LISTED_MAX);
    expect(data[2]!.text).toBe(`- for ${CALL}: ${RENEW}`);
    const none = inboxAssistData({ ...FACTS, items: new Map() });
    expect(none[2]!.text).toBe('(none)');
  });
});
