import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import { activityEvent, type ActivityEvent, type ActivityReport } from './activity-event.ts';
import { groupActivity } from './activity-groups.ts';

const STANDUP = createVaultPath('Inbox/Meetings/2026-10-06 Standup.md');
const KICKOFF = createVaultPath('Inbox/Meetings/2026-10-06 Kickoff.md');
const RULE = createVaultPath('.atlas/automations/After a meeting.md');

let clock = 0;
const line = (report: Partial<ActivityReport>): ActivityEvent =>
  activityEvent({
    level: 'info',
    kind: 'app',
    message: 'Something.',
    subject: null,
    ...report,
    at: (clock += 1),
  });
const imported = (meeting = STANDUP) =>
  line({ kind: 'meeting', message: 'Imported.', subject: { kind: 'note', path: meeting } });
const linked = (meeting = STANDUP) =>
  line({ kind: 'meeting', message: 'Linked.', subject: { kind: 'note', path: meeting } });
const ran = (notes: readonly ReturnType<typeof createVaultPath>[]) =>
  line({ kind: 'automation', message: 'Ran.', subject: { kind: 'rule', path: RULE }, notes });

describe('groupActivity', () => {
  it('gathers a meeting’s import and linking lines under it, with no rule run', () => {
    // Newest first, as the page shows them.
    const events = [linked(), imported(), line({ message: 'Synced.' })];
    expect(groupActivity(events)).toEqual([
      { kind: 'meeting', meeting: STANDUP, lines: [0, 1] },
      { kind: 'line', line: 2 },
    ]);
  });

  it('gathers the run of a rule that heard the meeting under it too', () => {
    const events = [ran([STANDUP]), line({ message: 'Synced.' }), linked(), imported()];
    expect(groupActivity(events)).toEqual([
      { kind: 'meeting', meeting: STANDUP, lines: [0, 2, 3] },
      { kind: 'line', line: 1 },
    ]);
  });

  it('leaves a run that heard several meetings as a line of its own', () => {
    const events = [ran([STANDUP, KICKOFF]), linked(), imported()];
    expect(groupActivity(events)).toEqual([
      { kind: 'line', line: 0 },
      { kind: 'meeting', meeting: STANDUP, lines: [1, 2] },
    ]);
  });

  it('leaves a run about a note no meeting line names as a line', () => {
    const task = createVaultPath('Tasks/Send the notes.md');
    const events = [ran([task]), line({ subject: { kind: 'note', path: task } })];
    expect(groupActivity(events)).toEqual([
      { kind: 'line', line: 0 },
      { kind: 'line', line: 1 },
    ]);
  });

  it('keeps a meeting with only one line as that line', () => {
    expect(groupActivity([imported()])).toEqual([{ kind: 'line', line: 0 }]);
  });

  it('keeps two meetings apart, each where its newest line is', () => {
    const events = [imported(KICKOFF), linked(STANDUP), linked(KICKOFF), imported(STANDUP)];
    expect(groupActivity(events)).toEqual([
      { kind: 'meeting', meeting: KICKOFF, lines: [0, 2] },
      { kind: 'meeting', meeting: STANDUP, lines: [1, 3] },
    ]);
  });

  it('does not take a line of another kind about the meeting as one of its own', () => {
    const saved = line({ kind: 'save', subject: { kind: 'note', path: STANDUP } });
    expect(groupActivity([saved, imported()])).toEqual([
      { kind: 'line', line: 0 },
      { kind: 'line', line: 1 },
    ]);
  });

  it('is empty for no lines', () => {
    expect(groupActivity([])).toEqual([]);
  });
});
