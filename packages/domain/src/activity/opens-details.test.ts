import { describe, expect, it } from 'vitest';
import { MAX_ACTIVITY_DETAIL, activityEvent } from './activity-event.ts';
import { activityLine, parseActivityLog } from './activity-file.ts';
import { automationFailedReport, indexNotKeptReport } from './activity-reports.ts';
import { opensDetails } from './opens-details.ts';

/** #815: which lines open to their details, and what the reports hand them. */

const AT = Date.UTC(2026, 8, 28, 9, 30);

describe('opensDetails', () => {
  it('opens a warning and an error, and not a line of plain news', () => {
    expect(opensDetails('warning')).toBe(true);
    expect(opensDetails('error')).toBe(true);
    expect(opensDetails('info')).toBe(false);
  });
});

describe('the reports that carry a detail', () => {
  it("keeps a failed run's problem past where the line cuts it short", () => {
    const problem = `The archive folder could not be made. ${'word '.repeat(120)}end`;
    const report = automationFailedReport({
      rule: { name: 'Tidy tasks', path: null },
      doing: 'run',
      problem,
    });
    const event = activityEvent({ ...report, at: AT });
    expect(event.message.endsWith('…')).toBe(true);
    expect(problem.length).toBeLessThan(MAX_ACTIVITY_DETAIL);
    expect(event.detail).toBe(problem);
    expect(parseActivityLog(activityLine(event))).toEqual([event]);
  });

  it("keeps a failed run's problem without the machine's paths", () => {
    const report = automationFailedReport({
      rule: { name: 'Tidy tasks', path: null },
      doing: 'undo',
      problem: 'cannot read /Users/mara/Vault/.atlas/log',
    });
    expect(activityEvent({ ...report, at: AT }).detail).toBe('cannot read <path>');
  });

  it('keeps what the browser said about an index it would not store', () => {
    expect(indexNotKeptReport('an unknown transient reason').detail).toBe(
      'an unknown transient reason',
    );
    expect('detail' in indexNotKeptReport(null)).toBe(false);
  });
});
