import { describe, expect, it } from 'vitest';
import { createVaultPath, type ActivityEvent } from '@dfai/domain';
import { activityRows } from './activity-rows.ts';
import { eventDetails, noticeDetails } from './event-details.ts';

/** #815: an event as its popup shows it. */

// Built from local parts, so the test reads the same in any timezone.
const AT = new Date(2026, 8, 28, 14, 3).getTime();
const TODAY = '2026-09-28';
const RULE = createVaultPath('.atlas/automations/Tidy tasks.md');

const FAILED: ActivityEvent = {
  at: AT,
  level: 'error',
  kind: 'automation',
  message: 'Tidy tasks: Could not run. disk full',
  subject: { kind: 'rule', path: RULE },
  notes: [createVaultPath('Meetings/Standup.md'), createVaultPath('Meetings/Kickoff.md')],
  detail: 'disk full',
};

describe('eventDetails', () => {
  it('shows the level, the time, the message, the subject by name and each detail', () => {
    expect(eventDetails(FAILED, TODAY)).toMatchObject({
      level: 'error',
      time: 'Today, 14:03',
      dateTime: '2026-09-28T14:03:00',
      message: 'Tidy tasks: Could not run. disk full',
      subject: 'Tidy tasks',
      details: [
        { label: 'Detail', value: 'disk full' },
        { label: 'Notes', value: 'Standup, Kickoff' },
      ],
    });
  });

  it('writes it all out as text to copy, a fact to a line', () => {
    expect(eventDetails(FAILED, TODAY).text).toBe(
      [
        'Error · Today, 14:03 (2026-09-28T14:03:00)',
        'Tidy tasks: Could not run. disk full',
        'About: Tidy tasks (.atlas/automations/Tidy tasks.md)',
        'Detail: disk full',
        'Notes: Standup, Kickoff',
      ].join('\n'),
    );
  });

  it('has no subject and no facts for a line that carries neither', () => {
    const plain: ActivityEvent = {
      at: AT,
      level: 'warning',
      kind: 'app',
      message: 'Kept for later.',
      subject: null,
    };
    const shown = eventDetails(plain, TODAY);
    expect(shown.subject).toBeNull();
    expect(shown.details).toEqual([]);
    expect(shown.text).toBe('Warning · Today, 14:03 (2026-09-28T14:03:00)\nKept for later.');
  });
});

describe('noticeDetails', () => {
  it('shows a notice in its own words, whole, as the toast said them, dated when shown', () => {
    const message = `Could not save /Users/mara/Vault/Plan.md: ${'the disk said no. '.repeat(30)}End.`;
    expect(message.length).toBeGreaterThan(300);
    const shown = noticeDetails({ message, level: 'error', at: AT }, TODAY);
    expect(shown).toEqual({
      level: 'error',
      time: 'Today, 14:03',
      dateTime: '2026-09-28T14:03:00',
      message,
      subject: null,
      details: [],
      text: `Error · Today, 14:03 (2026-09-28T14:03:00)\n${message}`,
    });
  });
});

describe('activityRows — which lines open', () => {
  it('gives a warning and an error their details, and a line of news none', () => {
    const news: ActivityEvent = { ...FAILED, level: 'info' };
    const warned: ActivityEvent = { ...FAILED, level: 'warning' };
    const [first, second, third] = activityRows([FAILED, warned, news], TODAY);
    expect(first?.details).toEqual(eventDetails(FAILED, TODAY));
    expect(second?.details?.level).toBe('warning');
    expect(third !== undefined && 'details' in third).toBe(false);
  });
});
