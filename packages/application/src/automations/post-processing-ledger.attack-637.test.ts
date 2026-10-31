import { describe, expect, it } from 'vitest';
import {
  AFTER_A_MEETING_PROMPT,
  createVaultPath,
  postProcessingFactsOf,
  postProcessingPending,
  type AutomationRule,
} from '@dfai/domain';
import type { LoadedAutomation } from './load-automations.ts';
import { postProcessingLedgerOf } from './post-processing-ledger.ts';

/**
 * Attack on PR #637 (#182): the ledger's reach is read from the `date` part of
 * the rule's `which` alone. A rule narrowed by anything else never takes some
 * meetings, and those must not be pending, or the other Mac says "waiting"
 * for them forever and the named Mac warns of them. Fictional names only.
 */

const narrowed = (which: string): LoadedAutomation => ({
  rule: {
    id: 'after-a-meeting',
    path: createVaultPath('.atlas/automations/After a meeting.md'),
    name: 'After a meeting',
    enabled: true,
    when: { kind: 'note', type: 'meeting', on: ['created'] },
    which,
    olderThanDays: null,
    action: {
      kind: 'claude',
      prompt: AFTER_A_MEETING_PROMPT,
      tools: [],
      output: { kind: 'proposals', schema: 'meeting-digest' },
      apply: 'mine',
    },
  } satisfies AutomationRule,
  log: [],
  ledger: null,
  idWritten: true,
});

const BODY = '# Café sync\n\n## Transcript\n\n**Mara Quill** [~00:00:00] Morning, Tobias. ^t0001\n';

describe('postProcessingLedgerOf: a rule narrowed by more than its date (attack on PR #637)', () => {
  it('leaves a meeting the rule’s `which` never takes out of pending', () => {
    const ledger = postProcessingLedgerOf(
      [narrowed('FROM meeting WHERE date >= @-14d AND kind = "standup"')],
      () => '2026-10-29',
    );
    const facts = postProcessingFactsOf({
      body: BODY,
      properties: { type: 'meeting', date: '2026-10-28', kind: 'one-on-one' },
      key: 'meeting:gemini:gemini-1a2b:transcript:abcd',
    });

    expect(
      postProcessingPending({
        path: 'Meetings/2026-10-28 Café sync.md',
        importOutcome: 'imported',
        facts,
        ledger,
      }),
    ).toBe(false);
  });
});
