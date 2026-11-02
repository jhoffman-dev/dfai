/**
 * #720: in the GitHub vault a note's `modified` is a version, not a time. The
 * catch-up when DFAI opens takes a meeting for missed when it was written
 * after the rule's own file; read as times, versions (up to 2^52) are after
 * almost anything, and the rule would run on nearly every meeting there is.
 */
import { createVaultPath, handledVersions, type NoteTrigger } from '@dfai/domain';
import { describe, expect, it } from 'vitest';
import type { IndexEntry } from '../index/ports.ts';
import { fakeMarkdown, fakeVaultFs } from '../testing/index.ts';
import type { NoteContents } from '../vault/ports.ts';
import { arrivalsMissed } from './note-runs.ts';

const RULE = createVaultPath('.atlas/automations/Tidy meetings.md');
const MEETING = 'Inbox/Meetings/2026-10-30 Larkspur sync.md';
const MEETING_CREATED: NoteTrigger = { kind: 'note', type: 'meeting', on: ['created'] };

/** The meeting as the index holds it: its `modified` far above the rule file's. */
const held = new Map<string, IndexEntry>([
  [
    MEETING,
    {
      path: MEETING,
      modified: 0x9f3a_1c2b_4d5e6,
      size: 40,
      type: 'meeting',
      digest: 'larkspur',
      importOutcome: 'imported',
      importDeclared: true,
    },
  ],
]);

function missedWhenTheRuleReads(ruleFile: NoteContents) {
  return arrivalsMissed({
    fs: fakeVaultFs({ readTextFile: async () => ruleFile }),
    markdown: fakeMarkdown(),
    held,
    rule: { path: RULE, action: { kind: 'set', values: { status: 'new' } } },
    trigger: MEETING_CREATED,
    handled: handledVersions([]),
  });
}

describe('arrivalsMissed: a vault that cannot tell when files were written', () => {
  it('catches up with nothing, however its versions compare', async () => {
    const missed = await missedWhenTheRuleReads({
      text: '',
      modified: 0x0001_2345_6789a,
      modifiedAt: null,
    });
    expect(missed).toEqual([]);
  });

  it('still catches up with a meeting written after the rule, where the host gives times', async () => {
    const missed = await missedWhenTheRuleReads({ text: '', modified: 1_000 });
    expect(missed).toEqual([{ path: MEETING, digest: 'larkspur' }]);
  });
});
