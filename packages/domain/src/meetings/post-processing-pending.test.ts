import { describe, expect, it } from 'vitest';
import { SUMMARY_DIGEST_KEY } from './meeting-summary-block.ts';
import {
  answeredIn,
  meetingReachFrom,
  NO_POST_PROCESSING,
  postProcessingFactsOf,
  postProcessingPending,
  type PostProcessingFacts,
  type PostProcessingLedger,
} from './post-processing-pending.ts';

/**
 * #182: the one definition of a meeting whose post-processing is pending —
 * what the waiting count adds, and what the Inbox row calls "summary pending".
 */

const PATH = 'Meetings/2026/10/2026-10-27 Larkspur weekly.md';
const KEY = 'meeting:gemini:gemini-7f3a9c21:transcript:9f8e';
const FACTS: PostProcessingFacts = {
  summary: 'none',
  hasTurns: true,
  date: '2026-10-27',
  key: KEY,
};
const LEDGER: PostProcessingLedger = {
  summarising: true,
  from: '2026-10-15',
  answered: new Set(),
  stored: new Set(),
};

const pending = ({
  facts = FACTS,
  ledger = LEDGER,
  path = PATH,
  importOutcome = 'imported' as const,
}: {
  facts?: PostProcessingFacts;
  ledger?: PostProcessingLedger;
  path?: string;
  importOutcome?: 'imported' | 'duplicate' | 'error' | null;
} = {}) => postProcessingPending({ path, importOutcome, facts, ledger });

describe('postProcessingPending', () => {
  it('is pending for an imported meeting the rule has not answered', () => {
    expect(pending()).toBe(true);
  });

  it('is pending while an answer stored for its words waits to be written, though its path was answered', () => {
    const ledger = { ...LEDGER, answered: new Set([PATH]), stored: new Set([KEY]) };
    expect(pending({ ledger })).toBe(true);
  });

  it('clears once the rule has answered it and keeps no answer waiting', () => {
    expect(pending({ ledger: { ...LEDGER, answered: new Set([PATH]) } })).toBe(false);
  });

  it('is not pending under another meeting’s stored answer', () => {
    const ledger = {
      ...LEDGER,
      answered: new Set([PATH]),
      stored: new Set(['meeting:x:y:transcript:z']),
    };
    expect(pending({ ledger })).toBe(false);
  });

  it('is not pending once a summary block is there, Claude’s or the person’s', () => {
    expect(pending({ facts: { ...FACTS, summary: 'written' } })).toBe(false);
    expect(pending({ facts: { ...FACTS, summary: 'edited' } })).toBe(false);
  });

  it('is not pending while no rule writes summaries', () => {
    expect(pending({ ledger: NO_POST_PROCESSING })).toBe(false);
  });

  it('is not pending for a meeting the import did not let in', () => {
    expect(pending({ importOutcome: null })).toBe(false);
    expect(pending({ importOutcome: 'duplicate' })).toBe(false);
    expect(pending({ importOutcome: 'error' })).toBe(false);
  });

  it('is not pending in the Archive', () => {
    expect(pending({ path: `Archive/${PATH}` })).toBe(false);
  });

  it('is not pending with no transcript turns to read', () => {
    expect(pending({ facts: { ...FACTS, hasTurns: false } })).toBe(false);
  });

  it('is not pending before the rule’s reach, and is on its first day', () => {
    expect(pending({ facts: { ...FACTS, date: '2026-10-14' } })).toBe(false);
    expect(pending({ facts: { ...FACTS, date: '2026-10-15' } })).toBe(true);
  });

  it('is not pending undated: the rule’s `date >= …` never matches a meeting with no date (#637 review)', () => {
    expect(pending({ facts: { ...FACTS, date: null } })).toBe(false);
  });
});

describe('answeredIn', () => {
  it('is answered only with the path known and no answer stored for its key', () => {
    const ledger = { answered: new Set([PATH]), stored: new Set([KEY]) };
    expect(answeredIn(ledger, { path: PATH, key: KEY })).toBe(false);
    expect(answeredIn(ledger, { path: PATH, key: null })).toBe(true);
    expect(answeredIn(ledger, { path: 'Other.md', key: null })).toBe(false);
  });
});

describe('postProcessingFactsOf', () => {
  const body = '## Transcript\n\n**Mara Quill** (00:00:05): Morning.\n';

  it('reads the turns, a date that is a day, and no summary', () => {
    expect(postProcessingFactsOf({ body, properties: { date: '2026-10-27' }, key: KEY })).toEqual({
      summary: 'none',
      hasTurns: true,
      date: '2026-10-27',
      key: KEY,
    });
  });

  it('leaves out a date that is not a day, and says a recorded digest with no block is the person’s', () => {
    const facts = postProcessingFactsOf({
      body: 'No transcript here.\n',
      properties: { date: 'next Tuesday', [SUMMARY_DIGEST_KEY]: 'abcd' },
      key: null,
    });
    expect(facts).toEqual({ summary: 'edited', hasTurns: false, date: null, key: null });
  });
});

describe('meetingReachFrom: how far back a rule that writes summaries reaches (#637 review)', () => {
  const TODAY = '2026-10-29';

  it('is the preset’s 14 days for the preset’s `date >= @-14d`', () => {
    expect(meetingReachFrom('FROM meeting WHERE date >= @-14d', TODAY)).toBe('2026-10-15');
  });

  it('is the rule’s own, narrower reach', () => {
    expect(meetingReachFrom('FROM meeting WHERE date >= @-7d', TODAY)).toBe('2026-10-22');
    expect(meetingReachFrom('FROM meeting WHERE date >= @weekAgo', TODAY)).toBe('2026-10-22');
    expect(meetingReachFrom('FROM meeting WHERE date >= @-14d AND date > 2026-10-20', TODAY)).toBe(
      '2026-10-21',
    );
  });

  it('never reaches past 14 days, whatever the rule takes', () => {
    expect(meetingReachFrom('FROM meeting WHERE date >= @-30d', TODAY)).toBe('2026-10-15');
    expect(meetingReachFrom('FROM meeting', TODAY)).toBe('2026-10-15');
  });

  it('proves no reach where only the index can tell the days: nothing is pending on it alone (#637 attack)', () => {
    const none = '2026-10-30';
    expect(meetingReachFrom('FROM meeting WHERE date >= @-7d OR kind = Standup', TODAY)).toBe(none);
    expect(meetingReachFrom('FROM meeting WHERE date >= @-7d AND kind = Standup', TODAY)).toBe(
      none,
    );
    expect(meetingReachFrom('FROM meeting WHERE NOT (date < @-7d)', TODAY)).toBe(none);
    expect(meetingReachFrom('FROM meeting WHERE date <= @-3d', TODAY)).toBe(none);
    expect(meetingReachFrom('FROM meeting WHERE date = @-3d', TODAY)).toBe(none);
  });

  it('takes no meeting for a `which` that does not read, which never runs', () => {
    expect(meetingReachFrom('FROM meeting WHERE (', TODAY)).toBe('2026-10-30');
  });
});

describe('postProcessingPending with what the index says the rules take (#637 attack)', () => {
  const taken = (paths: string[]) => ({
    ...LEDGER,
    from: '2026-10-30',
    taken: { paths: new Set(paths), from: '2026-10-15' },
  });

  it('counts a meeting the rules’ own queries take, from the 14 days, whatever the `which` proves', () => {
    expect(pending({ ledger: taken([PATH]) })).toBe(true);
  });

  it('counts none the queries do not take, nor one before the 14 days', () => {
    expect(pending({ ledger: taken(['Meetings/Other.md']) })).toBe(false);
    expect(pending({ ledger: taken([PATH]), facts: { ...FACTS, date: '2026-10-14' } })).toBe(false);
  });
});

describe('postProcessingFactsOf reads the day as the query does (#637 attack)', () => {
  it('reads a datetime by its day, and a list by its first item', () => {
    const of = (date: unknown) =>
      postProcessingFactsOf({ body: '', properties: { date }, key: null }).date;
    expect(of('2026-10-28T10:00:00-04:00')).toBe('2026-10-28');
    expect(of(['2026-10-27', '2026-10-28'])).toBe('2026-10-27');
    expect(of('28/10/2026')).toBeNull();
    expect(of(20261028)).toBeNull();
  });
});
