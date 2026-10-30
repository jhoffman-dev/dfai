/**
 * Attack on PR #642 (#192): a re-link whose only write is the mark's own
 * removal linked nothing, yet `linkingOwed` counts that write as "wrote into
 * the meeting" and settles it — so the meeting is never linked again, which
 * ADR-0027's "As built (#192)" says is owed (a key changed since it was read,
 * or a key holding something other than links).
 */
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_PRESETS,
  createVaultPath,
  parseObjectType,
  type AutomationRule,
} from '@dfai/domain';
import { meetingsNotLinked } from '../automations/meetings-not-linked.ts';
import { automationVault, jsonNote, TASK_TYPES } from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { MEETING_HEADER, meetingFile } from '../testing/meeting-files.ts';
import { createMeetingLinker } from './link-imported-meetings.ts';
import { relinkMeetings } from './relink-meetings.ts';

const TODAY = '2026-10-06';
const VAULT = '/vaults/home';
const MEETING = 'Inbox/Meetings/2026-10-06 Standup.md';
const MARA = 'People/Mara Quill.md';
const TYPES = [
  ...TASK_TYPES,
  parseObjectType({ name: 'meeting', label: 'Meeting', properties: { date: 'date' } }),
];

const marked = (fields: Record<string, unknown> = {}) =>
  meetingFile({
    ...MEETING_HEADER,
    atlas_import_outcome: 'imported',
    atlas_links: 'failed',
    ...fields,
  });

function setUp(meeting: string) {
  const vault = automationVault({
    notes: {
      [MEETING]: meeting,
      [MARA]: jsonNote({ type: 'person', email: 'mara.quill@example.com' }),
    },
    today: TODAY,
    types: TYPES,
  });
  const linker = createMeetingLinker({
    ports: () => vault.ports,
    clock: { today: () => TODAY },
    activity: recordingActivity(),
    openVault: () => VAULT,
    selfName: () => null,
    selfEmails: () => [],
    onWritten: () => undefined,
  });
  const relink = () =>
    relinkMeetings({ link: (paths) => linker(VAULT, paths), paths: [createVaultPath(MEETING)] });
  return { vault, relink };
}

describe('attack #642: removing the mark alone is not linking the meeting', () => {
  it.fails('keeps the mark when every link key changed since it was read', async () => {
    const { vault, relink } = setUp(marked());
    // The owner saves a person of their own into `people` while the linker reads the directory.
    const read = vault.ports.fs.readTextFile.bind(vault.ports.fs);
    let reads = 0;
    vault.ports.fs.readTextFile = async (path) => {
      const got = await read(path);
      if (path === MEETING && ++reads === 1)
        vault.files.set(MEETING, marked({ people: ['[[Tobias Fenn]]'] }));
      return got;
    };

    const outcome = await relink();

    // Nothing was linked: Mara is not in `people`, only what the owner wrote.
    expect(vault.properties(MEETING)['people']).toEqual(['[[Tobias Fenn]]']);
    expect(outcome.notLinked).toEqual([MEETING]);
    expect(vault.properties(MEETING)['atlas_links']).toBe('failed');
  });

  it.fails('keeps the mark when its people holds something other than links', async () => {
    // The import marks exactly this meeting (linkingOwed: wrote nothing, left the meeting).
    const { vault, relink } = setUp(marked({ people: [{ name: 'Mara and Ada' }] }));

    const outcome = await relink();

    expect(vault.properties(MEETING)['people']).toEqual([{ name: 'Mara and Ada' }]);
    expect(outcome.notLinked).toEqual([MEETING]);
    expect(vault.properties(MEETING)['atlas_links']).toBe('failed');
  });
});

describe('attack #642: old marked meetings do not hide a new one', () => {
  // The shipped rule, as presets write it: it matches the last 14 days of meetings.
  const preset = AUTOMATION_PRESETS.find((draft) => draft.name === 'After a meeting')!;
  const rule: AutomationRule = {
    ...preset,
    id: 'After a meeting',
    path: createVaultPath('.atlas/automations/After a meeting.md'),
  } as AutomationRule;

  it.fails(
    'finds a marked meeting from today behind a thousand marked meetings from January',
    async () => {
      // A backfill of old meetings let in while the index was rebuilding: each is marked, none is in the rule's 14 days.
      const old = Object.fromEntries(
        Array.from({ length: 1000 }, (_, at) => [
          `Inbox/Meetings/2026-01-05 Sync ${String(at).padStart(4, '0')}.md`,
          marked({ date: '2026-01-05', external_id: `gemini-old-${at}` }),
        ]),
      );
      const vault = automationVault({
        notes: { ...old, [MEETING]: marked() },
        today: TODAY,
        types: TYPES,
      });

      const found = await meetingsNotLinked({
        ports: { ...vault.ports, notePaths: [...vault.files.keys()] },
        rule,
        today: TODAY,
      });

      expect(found?.paths).toEqual([MEETING]);
    },
  );
});
