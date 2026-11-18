/**
 * Rows as the preview plans them, and notes as Apply reads them, for the
 * re-check's tests (#909). Every row comes from {@link assistPlan} over the
 * item's own facts, as the preview makes it, never written by hand. All names
 * are made up.
 */
import type { TaskCandidate } from '../gtd/task-similarity.ts';
import type { PersonCandidate } from '../people/person-match.ts';
import { digestOf } from '../sources/merge.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import type { AssistItemAnswer } from './assist-answer.ts';
import { assistItemFacts } from './assist-item-facts.ts';
import { assistPlan, type AssistFacts, type AssistRow } from './assist-plan.ts';
import type { AssistEvidence, AssistNoteNow, AssistRecheckInput } from './assist-recheck.ts';
import { inboxItem, type InboxItem } from './inbox.ts';

export const NOW = Date.UTC(2026, 10, 17, 9);
/** An hour before {@link NOW}: a note left alone. */
export const QUIET = NOW - 60 * 60_000;

export const LARKSPUR = {
  path: createVaultPath('Projects/Larkspur Payroll.md'),
  title: 'Larkspur Payroll',
};
export const MARA = { path: createVaultPath('People/Mara Quill.md'), title: 'Mara Quill' };
export const KEPT_PATH = createVaultPath('Tasks/Renew Larkspur contract.md');

export const MARA_CANDIDATE: PersonCandidate = {
  path: MARA.path,
  name: 'Mara Quill',
  emails: ['mara.quill@example.com'],
  aliases: [],
};

export const VAULT: Omit<AssistFacts, 'items'> = {
  today: '2026-11-17',
  filingTargets: [LARKSPUR],
  people: [MARA],
  directory: [MARA_CANDIDATE],
  takenTitles: new Set(),
};

export const KEPT_TASK: TaskCandidate = {
  path: KEPT_PATH,
  title: 'Renew Larkspur contract',
  project: null,
  status: 'next-action',
  due: null,
  dueUnread: false,
  defer: null,
  recurrence: null,
  waitingOn: '',
  contexts: [],
  people: [],
};
export const KEPT_TEXT =
  '---\ntype: task\nstatus: next-action\ncreated: 2026-11-01\n---\n\nRenew it.\n';

/** The frontmatter of a test note, read as `key: value` lines: what the markdown port gives, for these notes. */
export function propertiesOf(text: string): NonNullable<AssistNoteNow['properties']> {
  const block = /^---\n([\s\S]*?)\n---\n/u.exec(text)?.[1] ?? '';
  const written = new Map<string, readonly string[]>();
  for (const line of block.split('\n')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const value = line.slice(at + 1).trim();
    if (value !== '') written.set(line.slice(0, at).trim().toLowerCase(), [value]);
  }
  const people = written.get('people');
  return {
    written,
    listedPeople: people === undefined ? null : { resolved: null, written: people },
  };
}

export const answerFor = (
  item: VaultPath,
  extra: Partial<AssistItemAnswer> = {},
): AssistItemAnswer => ({
  item,
  kind: 'task',
  projects: [],
  due: null,
  waitingOn: null,
  confidence: 'high',
  why: 'Something to do.',
  duplicateOf: null,
  people: [],
  ...extra,
});

export interface Previewed {
  readonly row: AssistRow;
  readonly evidence: AssistEvidence;
  readonly text: string;
}

/** The row and evidence the preview makes of one item: its file's `text`, and Claude's answer. */
export function preview({
  title,
  text,
  answer,
  vault = VAULT,
  tasks = [],
  keptText = KEPT_TEXT,
}: {
  title: string;
  text: string;
  answer?: Partial<AssistItemAnswer>;
  vault?: Omit<AssistFacts, 'items'>;
  tasks?: readonly TaskCandidate[];
  keptText?: string;
}): Previewed {
  const item: InboxItem = inboxItem({
    path: createVaultPath(`Inbox/${title}.md`),
    title,
    type: null,
  });
  const read = propertiesOf(text);
  const items = assistItemFacts({
    asked: [
      { item, text, modified: QUIET, listedPeople: read.listedPeople, written: read.written },
    ],
    tasks,
  });
  const given = answerFor(item.path, answer);
  const row = assistPlan(item, given, { ...vault, items });
  const kept =
    row.step.kind === 'duplicate' ? { path: row.step.of.path, digest: digestOf(keptText) } : null;
  return { row, evidence: { item, answer: given, digest: digestOf(text), kept }, text };
}

export const noteNow = (text: string, extra: Partial<AssistNoteNow> = {}): AssistNoteNow => ({
  text,
  modified: QUIET,
  unsaved: false,
  properties: propertiesOf(text),
  ...extra,
});

/** The re-check's input for a previewed row, every note as the preview read it unless said otherwise. */
export function recheckOf(
  previewed: Previewed,
  extra: Partial<AssistRecheckInput> = {},
  tasks: readonly TaskCandidate[] = [KEPT_TASK],
): AssistRecheckInput {
  const duplicate = previewed.row.step.kind === 'duplicate';
  return {
    row: previewed.row,
    evidence: previewed.evidence,
    item: noteNow(previewed.text),
    kept: duplicate ? { ...noteNow(KEPT_TEXT), task: KEPT_TASK } : null,
    vault: VAULT,
    tasks,
    cut: false,
    now: NOW,
    ...extra,
  };
}
