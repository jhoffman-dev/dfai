import { describe, expect, it } from 'vitest';
import { automationEntryReport } from '../activity/activity-reports.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { formatLogEntry, newLogText, parseRunLog, type LogEntry } from './run-log.ts';

/**
 * #788: the tokens a Claude step spent, summed over its asks, in its rule's
 * log — read back as written — and, shortly, in its Activity line.
 */

const RULE = { name: 'Meeting actions', path: createVaultPath('.atlas/automations/M.md') };
const USAGE = { input: 9000, cacheCreation: 2100, cacheRead: 30_100, output: 2140 };

const RAN: LogEntry = {
  kind: 'run',
  at: '2026-11-07T09:00:00',
  trigger: 'hand',
  done: [{ kind: 'proposed', path: createVaultPath('Inbox/Proposals/Call Mara Quill.md') }],
  left: [],
  capped: false,
  claude: { model: 'claude-opus-5-5', ms: 4210, asks: 2, usage: USAGE },
};
const FAILED: LogEntry = {
  kind: 'failed',
  at: '2026-11-07T09:05:00',
  trigger: 'hand',
  problem: 'Claude’s answer did not read.',
  claude: { model: 'claude-opus-5-5', ms: 900, asks: 1, usage: USAGE },
};

const roundTrip = (entry: LogEntry): LogEntry | undefined =>
  parseRunLog(newLogText('Meeting actions', [entry]))[0];

describe('a Claude step’s usage in its rule’s log', () => {
  it('says what it read, from the cache and into it, and what it wrote', () => {
    expect(formatLogEntry(RAN)).toContain(
      '- usage in `41200` (cached `30100`, written `2100`) out `2140`\n',
    );
  });

  it('says the cost when the provider said one', () => {
    const costed: LogEntry = {
      ...RAN,
      claude: { ...RAN.claude!, usage: { ...USAGE, costUsd: 0.41 } },
    };
    expect(formatLogEntry(costed)).toContain(
      '- usage in `41200` (cached `30100`, written `2100`) out `2140` cost `0.41` USD',
    );
    expect(roundTrip(costed)).toEqual(costed);
  });

  it('reads it back as written, for a run and for a failure', () => {
    expect(roundTrip(RAN)).toEqual(RAN);
    expect(roundTrip(FAILED)).toEqual(FAILED);
  });

  it('writes no usage line when the usage is unknown', () => {
    const unknown: LogEntry = { ...RAN, claude: { model: 'claude-opus-5-5', ms: 4210, asks: 2 } };
    expect(formatLogEntry(unknown)).not.toContain('- usage');
    expect(roundTrip(unknown)).toEqual(unknown);
  });

  it.each([
    [
      'a count that is no number',
      '- usage in `"many"` (cached `30100`, written `2100`) out `2140`',
    ],
    ['a negative count', '- usage in `41200` (cached `30100`, written `2100`) out `-1`'],
    ['a fractional count', '- usage in `41200` (cached `30100`, written `2100`) out `2.5`'],
    ['more cached than read', '- usage in `100` (cached `30100`, written `2100`) out `2140`'],
    [
      'a cost that is no number',
      '- usage in `41200` (cached `30100`, written `2100`) out `2140` cost `"a lot"` USD',
    ],
  ])('leaves out a usage line edited into %s, keeping the rest', (_, edited) => {
    const text = formatLogEntry(RAN).replace(/^- usage .*$/m, edited);
    const [entry] = parseRunLog(`${newLogText('Meeting actions', [])}${text}`);
    expect(entry).toMatchObject({ kind: 'run', claude: { model: 'claude-opus-5-5', asks: 2 } });
    expect(entry?.kind === 'run' && entry.claude).not.toHaveProperty('usage');
  });
});

describe('a Claude step’s usage in Activity', () => {
  it('says it short, after the model and the time', () => {
    expect(automationEntryReport(RULE, RAN)?.message).toBe(
      'Meeting actions: Ran by hand. Made 1 proposal. Asked claude-opus-5-5, 4.2 s, 41k in (30k cached), 2.1k out.',
    );
  });

  it('says it for a failed run that was asked', () => {
    expect(automationEntryReport(RULE, FAILED)?.message).toContain(
      'Asked claude-opus-5-5, 0.9 s, 41k in (30k cached), 2.1k out.',
    );
  });

  it('says nothing of usage it does not know', () => {
    const unknown: LogEntry = { ...RAN, claude: { model: 'claude-opus-5-5', ms: 4210 } };
    expect(automationEntryReport(RULE, unknown)?.message).toMatch(
      /Asked claude-opus-5-5, 4\.2 s\.$/,
    );
  });
});
