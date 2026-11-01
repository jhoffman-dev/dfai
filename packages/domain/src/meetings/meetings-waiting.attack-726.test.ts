import { describe, expect, it } from 'vitest';
import { NO_POST_PROCESSING } from './post-processing-pending.ts';
import {
  waitingMeetingTally,
  type CountableStanding,
  type WaitingMeetingFile,
} from './meetings-waiting.ts';

/**
 * PR #726 attack: an unknown write time (`modifiedAt: null`, the session and
 * GitHub vaults) is read as +Infinity, which no pull ever finishes after. The
 * comment says such a meeting is "left for the next one", but no next pull
 * counts it: it is deferred for good. The desktop is not affected — the Tauri
 * vault reports no `modifiedAt`, so `writtenAt` falls back to the mtime.
 */

const UNKNOWN_TIME: WaitingMeetingFile = {
  path: 'Inbox/Meetings/2026-10-27 Larkspur weekly.md',
  read: {
    importDeclared: true,
    importOutcome: null,
    modifiedAt: null,
    postProcessing: { summary: 'none', hasTurns: true, date: '2026-10-20', key: null },
  },
};

const pulledAt = (finishedAt: number): CountableStanding => ({
  kind: 'pulled',
  startedAsleepMs: 5_000,
  finishedAt,
  namedAfter: false,
});

describe('a waiting meeting whose vault cannot tell when it was written (#726 attack)', () => {
  it.fails('is counted by some later pull, not deferred by every pull there will ever be', () => {
    const later = [1_000_000, 2_000_000_000_000, Number.MAX_SAFE_INTEGER].map((finishedAt) =>
      waitingMeetingTally([UNKNOWN_TIME], pulledAt(finishedAt), NO_POST_PROCESSING),
    );

    expect(later.some((tally) => tally.count === 1)).toBe(true);
  });
});
