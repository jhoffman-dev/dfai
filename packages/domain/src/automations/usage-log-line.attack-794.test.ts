import { describe, expect, it } from 'vitest';
import { newLogText, parseRunLog, type ClaudeRunInfo, type LogEntry } from './run-log.ts';

/**
 * Attack on PR #794 (#788): a usage line reads back as written, or not at
 * all — never as a different count. The line stores the input total and
 * subtracts the cache counts on read, which is exact only for safe integers,
 * yet the readers (`readApiUsage`, `usageOf`) accept any integer.
 */

const ran = (claude: ClaudeRunInfo): LogEntry => ({
  kind: 'run',
  at: '2026-11-07T09:00:00',
  trigger: 'hand',
  done: [],
  left: [],
  capped: false,
  claude,
});

describe('a usage line with counts past 2^53 (attack #794)', () => {
  it.fails('never reads back a fresh-input count other than the one written', () => {
    const usage = { input: 1, cacheCreation: 0, cacheRead: 2 ** 53, output: 1 };
    const entry = ran({ model: 'claude-opus-5-5', ms: 1, asks: 1, usage });
    const back = parseRunLog(newLogText('R', [entry]))[0];
    const read = back?.kind === 'run' ? back.claude?.usage : undefined;
    // Observed: input reads back as 0 (2^53 + 1 rounds to 2^53 in the total).
    expect(read === undefined || read.input === usage.input).toBe(true);
  });
});
