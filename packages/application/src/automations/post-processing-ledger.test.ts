import { describe, expect, it } from 'vitest';
import {
  AFTER_A_MEETING_PROMPT,
  createVaultPath,
  emptyLedger,
  type AutomationRule,
  type HandledLedger,
  type LogEntry,
} from '@dfai/domain';
import { jsonNote } from '../testing/automation-vault.ts';
import { MEETING_BODY, MEETING_HEADER } from '../testing/meeting-files.ts';
import type { LoadedAutomation } from './load-automations.ts';
import {
  postProcessingKeyOf,
  postProcessingLedgerOf,
  postProcessingMark,
  stepUnavailable,
} from './post-processing-ledger.ts';

/** #182: what the rules that write summaries have finished with, read from rules already loaded. */

const SUMMARISING: AutomationRule = {
  id: 'after-a-meeting',
  path: createVaultPath('.atlas/automations/After a meeting.md'),
  name: 'After a meeting',
  enabled: true,
  when: { kind: 'note', type: 'meeting', on: ['created'] },
  which: 'FROM meeting',
  olderThanDays: null,
  action: {
    kind: 'claude',
    prompt: AFTER_A_MEETING_PROMPT,
    tools: [],
    output: { kind: 'proposals', schema: 'meeting-digest' },
    apply: 'mine',
  },
};
const PROPOSING: AutomationRule = {
  ...SUMMARISING,
  id: 'proposals-only',
  action: {
    kind: 'claude',
    prompt: AFTER_A_MEETING_PROMPT,
    tools: [],
    output: { kind: 'proposals', schema: 'meeting-digest' },
  },
};

const ran = (path: string): LogEntry => ({
  kind: 'run',
  at: '2026-10-08T09:00:00',
  trigger: 'note',
  done: [],
  left: [],
  capped: false,
  versions: [{ path: createVaultPath(path), digest: 'd1', wrote: false }],
});

const loaded = (
  rule: AutomationRule,
  { log = [], ledger = null }: { log?: LogEntry[]; ledger?: HandledLedger | null } = {},
): LoadedAutomation => ({ rule, log, ledger, idWritten: true });

describe('postProcessingLedgerOf', () => {
  it('gathers what the summarising rules handled, answered and keep stored, and their reach', () => {
    const ledger: HandledLedger = {
      ...emptyLedger(),
      paths: new Map([['Meetings/A.md', { at: 1, digests: ['a'] }]]),
      answered: [{ at: 1, path: createVaultPath('Meetings/B.md'), keys: ['b'] }],
      stored: [{ key: 'meeting:gemini:x:transcript:1', at: 1, answers: ['{}'], parts: ['p'] }],
    };
    const read = postProcessingLedgerOf(
      [loaded(SUMMARISING, { ledger, log: [ran('Meetings/C.md')] })],
      '2026-10-15',
    );

    expect(read).toEqual({
      summarising: true,
      from: '2026-10-01',
      answered: new Set(['Meetings/A.md', 'Meetings/B.md', 'Meetings/C.md']),
      stored: new Set(['meeting:gemini:x:transcript:1']),
    });
  });

  it('reads nothing from a rule that writes no summaries, nor one turned off', () => {
    const off = { ...SUMMARISING, enabled: false };
    const read = postProcessingLedgerOf(
      [
        loaded(PROPOSING, { log: [ran('Meetings/C.md')] }),
        loaded(off, { log: [ran('Meetings/D.md')] }),
      ],
      '2026-10-15',
    );

    expect(read.summarising).toBe(false);
    expect(read.answered.size).toBe(0);
  });
});

describe('postProcessingMark', () => {
  it('moves when what was answered moves, and not for the same ledger read again', () => {
    const one = postProcessingLedgerOf(
      [loaded(SUMMARISING, { log: [ran('Meetings/C.md')] })],
      '2026-10-15',
    );
    const again = postProcessingLedgerOf(
      [loaded(SUMMARISING, { log: [ran('Meetings/C.md')] })],
      '2026-10-15',
    );
    const more = postProcessingLedgerOf(
      [loaded(SUMMARISING, { log: [ran('Meetings/C.md'), ran('Meetings/E.md')] })],
      '2026-10-15',
    );

    expect(postProcessingMark(again)).toBe(postProcessingMark(one));
    expect(postProcessingMark(more)).not.toBe(postProcessingMark(one));
  });
});

describe('stepUnavailable', () => {
  it('is why the summarising rule is held back for Claude, and nothing for another rule', () => {
    const rules = [loaded(PROPOSING), loaded(SUMMARISING)];
    const pauses = new Map([
      ['proposals-only', { unavailable: 'Not logged in.' }],
      ['after-a-meeting', {}],
    ]);

    expect(stepUnavailable(rules, pauses)).toBeNull();
    pauses.set('after-a-meeting', { unavailable: 'Not installed.' });
    expect(stepUnavailable(rules, pauses)).toBe('Not installed.');
  });
});

describe('postProcessingKeyOf', () => {
  it('names an imported meeting by its provider, id and transcript', () => {
    const header = { ...MEETING_HEADER, atlas_import_outcome: 'imported' };
    const text = jsonNote(header, MEETING_BODY);
    const properties: Record<string, unknown> = header;

    expect(postProcessingKeyOf({ text, properties })).toMatch(
      /^meeting:gemini:gemini-7f3a9c21:transcript:[0-9a-f]+$/,
    );
    expect(postProcessingKeyOf({ text, properties: MEETING_HEADER })).toBeNull();
  });
});
