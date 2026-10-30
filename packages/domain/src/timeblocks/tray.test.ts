import { describe, expect, it } from 'vitest';
import type { TaskSchedule } from './scheduling.ts';
import { trayOrder, type TrayTask } from './tray.ts';

/** P31-02: the planning tray lists next actions, those with no time set aside first. */
const scheduledFor = (minutes: number): TaskSchedule => ({
  estimate: 60,
  scheduled: minutes,
  done: 0,
  overBy: 0,
});

const tray = (title: string, schedule: TaskSchedule | null, chosen = false): TrayTask => ({
  path: `${title}.md`,
  title,
  schedule,
  chosen,
});

describe('the tray’s order', () => {
  it('puts the unscheduled first, each part in the order Next actions gives', () => {
    const tasks = [
      tray('Book the hall', scheduledFor(30)),
      tray('Call the bank', scheduledFor(0)),
      tray('Draft the memo', scheduledFor(60)),
      tray('File the claim', scheduledFor(0)),
    ];

    expect(trayOrder(tasks).map((task) => task.title)).toEqual([
      'Call the bank',
      'File the claim',
      'Book the hall',
      'Draft the memo',
    ]);
  });

  it('counts a task whose schedule could not be read as unscheduled', () => {
    const tasks = [tray('Planned', scheduledFor(15)), tray('Unread', null)];

    expect(trayOrder(tasks).map((task) => task.title)).toEqual(['Unread', 'Planned']);
  });

  it('puts what was chosen for today first (#108), the unscheduled of it first', () => {
    const tasks = [
      tray('Book the hall', scheduledFor(0)),
      tray('Call the bank', scheduledFor(30), true),
      tray('Draft the memo', scheduledFor(45)),
      tray('File the claim', scheduledFor(0), true),
    ];

    expect(trayOrder(tasks).map((task) => task.title)).toEqual([
      'File the claim',
      'Call the bank',
      'Book the hall',
      'Draft the memo',
    ]);
  });
});
