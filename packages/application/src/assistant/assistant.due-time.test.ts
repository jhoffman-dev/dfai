/**
 * #928 (attack-930): the assistant's open loops and brief say a task is
 * overdue as Today does — a timed due today is overdue the minute after its
 * time, on the injected clock's wall time; a brief of another day reads dues
 * by their day.
 */
import { describe, expect, it } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import {
  ASSISTANT_FILES,
  ASSISTANT_TODAY,
  assistantVault,
  jsonNote,
  MIGRATION,
} from '../testing/assistant-vault.ts';
import { readBrief } from './read-brief.ts';
import { readOpenLoops } from './read-open-loops.ts';

const PATH = 'Tasks/Draft the plan.md';
const files = {
  ...ASSISTANT_FILES,
  [PATH]: jsonNote({
    type: 'task',
    status: 'next-action',
    project: '[[Payroll Migration]]',
    due: `${ASSISTANT_TODAY}T09:00`,
  }),
};

const clockAt = (time: string) => ({
  today: () => ASSISTANT_TODAY,
  localNow: () => `${ASSISTANT_TODAY}T${time}:00`,
});

async function overdueAt(time: string): Promise<boolean | undefined> {
  const { reads } = assistantVault({ files });
  const loops = await readOpenLoops({
    reads,
    clock: clockAt(time),
    path: createVaultPath(MIGRATION),
  });
  return loops.openTasks.find((task) => task.path === PATH)?.overdue;
}

describe('the assistant, a timed due today (#928)', () => {
  it('is not overdue at its time, and is the minute after', async () => {
    expect(await overdueAt('09:00')).toBe(false);
    expect(await overdueAt('09:01')).toBe(true);
  });

  it('is read by its day where the clock tells no time', async () => {
    const { reads } = assistantVault({ files });
    const loops = await readOpenLoops({
      reads,
      clock: { today: () => ASSISTANT_TODAY },
      path: createVaultPath(MIGRATION),
    });
    expect(loops.openTasks.find((task) => task.path === PATH)?.overdue).toBe(false);
  });

  it('is said overdue by a brief of today, and not by one of an earlier day', async () => {
    const { reads } = assistantVault({ files });
    const path = createVaultPath(MIGRATION);
    const today = await readBrief({ reads, clock: clockAt('10:00'), path, date: null });
    expect(today.openTasks.find((task) => task.path === PATH)?.overdue).toBe(true);
    const asked = await readBrief({ reads, clock: clockAt('10:00'), path, date: '2999-03-12' });
    expect(asked.openTasks.find((task) => task.path === PATH)?.overdue).toBe(false);
  });
});
