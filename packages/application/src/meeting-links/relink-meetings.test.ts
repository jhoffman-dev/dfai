/**
 * #192: a meeting whose linking failed as it was let in carries a mark, the
 * "After a meeting" rule's dry run says it is not linked, and its Run now
 * links it — once. Over the fake vault whose index answers with real SQL.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AFTER_A_MEETING_PROMPT,
  builtInPromptAt,
  createVaultPath,
  describePlan,
  parseObjectType,
  type AutomationRule,
  type RunTrigger,
  type VaultPath,
} from '@dfai/domain';
import type { ModelEvent } from '../chat/ports.ts';
import { dryRunAutomation } from '../automations/dry-run-automation.ts';
import { runAutomation } from '../automations/run-automation.ts';
import { createMeetingImporter } from '../meetings/meeting-importer.ts';
import { automationVault, jsonNote, TASK_TYPES } from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeClaudeStepPorts } from '../testing/fake-claude-step.ts';
import { MEETING_HEADER, meetingFile } from '../testing/meeting-files.ts';
import { createMeetingLinker, linkBeforeLetIn } from './link-imported-meetings.ts';
import { meetingsNotLinked } from '../automations/meetings-not-linked.ts';
import { relinkMeetings } from './relink-meetings.ts';

const TODAY = '2026-10-06';
const CLOCK = {
  today: () => TODAY,
  localNow: () => `${TODAY}T09:00:00`,
  now: () => Date.parse(`${TODAY}T09:00:00Z`),
};
const VAULT = '/vaults/home';
const MEETING = 'Inbox/Meetings/2026-10-06 Standup.md';
const MARA = 'People/Mara Quill.md';
const TYPES = [
  ...TASK_TYPES,
  parseObjectType({ name: 'meeting', label: 'Meeting', properties: { date: 'date' } }),
];
const NOTHING: ModelEvent[] = [{ type: 'text', text: JSON.stringify({ items: [] }) }];

const RULE: AutomationRule = {
  id: 'After a meeting',
  path: createVaultPath('.atlas/automations/After a meeting.md'),
  name: 'After a meeting',
  enabled: true,
  when: { kind: 'note', type: 'meeting', on: ['created'] },
  which: 'FROM meeting',
  olderThanDays: null,
  action: {
    kind: 'claude',
    prompt: AFTER_A_MEETING_PROMPT,
    tools: [],
    output: { kind: 'proposals', schema: 'meeting-items' },
    apply: 'mine',
  },
};

function setUp(notes: Record<string, string> = { [MEETING]: meetingFile() }) {
  const claude = fakeClaudeStepPorts({
    rounds: Array.from({ length: 6 }, () => NOTHING),
    model: 'claude-sonnet-5-5',
    today: TODAY,
  });
  const vault = automationVault({
    notes: {
      [AFTER_A_MEETING_PROMPT]: builtInPromptAt(AFTER_A_MEETING_PROMPT)!.contents,
      [MARA]: jsonNote({ type: 'person', email: 'mara.quill@example.com' }),
      ...notes,
    },
    today: TODAY,
    types: TYPES,
    claude,
  });
  // Linking's index refuses while `broken` holds: what makes linking fail as the meeting is let in.
  const state = { broken: false };
  const refusing = {
    ...vault.ports,
    index: {
      ...vault.ports.index,
      query: () => Promise.reject(new Error('the index is rebuilding')),
    },
  };
  const activity = recordingActivity();
  const linker = createMeetingLinker({
    ports: () => (state.broken ? refusing : vault.ports),
    clock: CLOCK,
    activity,
    openVault: () => VAULT,
    selfName: () => null,
    selfEmails: () => [],
    onWritten: () => undefined,
  });
  const link = vi.fn((paths: readonly VaultPath[]) => linker(VAULT, paths));
  const importer = createMeetingImporter({
    ports: () => vault.ports,
    clock: CLOCK,
    activity,
    openVault: () => VAULT,
    active: () => true,
    onWritten: () => undefined,
    beforeLetIn: (vaultKey, path, reading) =>
      linkBeforeLetIn({ linker, vault: vaultKey, path, reading }),
  });
  const ports = { ...vault.ports, notePaths: [...vault.files.keys()] };
  const dryRun = () =>
    dryRunAutomation({
      ports,
      rule: RULE,
      log: [],
      named: { name: RULE.name, path: RULE.path },
      today: TODAY,
      activity,
    });
  const run = (trigger: RunTrigger) =>
    runAutomation({
      ports: vault.ports,
      rule: RULE,
      clock: CLOCK,
      guard: { vault: VAULT, currentVault: () => VAULT },
      activity,
      trigger,
      relink: (paths) => relinkMeetings({ link, paths, ports: vault.ports, today: TODAY }),
    });
  const runNow = () => run('hand');
  return {
    vault,
    state,
    activity,
    importer,
    link,
    dryRun,
    runNow,
    run,
    asked: () => claude.fake.requests,
  };
}

/** Every text written to the meeting, in order. */
function writesTo(vault: ReturnType<typeof automationVault>, path: string): string[] {
  const versions: string[] = [];
  const write = vault.ports.fs.writeTextFile;
  vault.ports.fs.writeTextFile = async (args) => {
    if (args.path === path) versions.push(args.contents);
    return write(args);
  };
  return versions;
}

describe('a meeting whose linking failed as it was let in', () => {
  it('is stamped imported all the same, with the mark that it is not linked', async () => {
    const { vault, state, importer, activity } = setUp();
    state.broken = true;

    await importer.catchUp(VAULT);

    expect(vault.properties(MEETING)).toMatchObject({
      atlas_import_outcome: 'imported',
      atlas_links: 'failed',
    });
    expect(vault.properties(MEETING)['people']).toBeUndefined();
    expect(activity.reports.map(({ message }) => message)).toContain(
      'Could not link the meeting: the index is rebuilding',
    );
  });

  it('carries no mark when linking worked', async () => {
    const { vault, importer } = setUp();

    await importer.catchUp(VAULT);

    expect(vault.properties(MEETING)['people']).toEqual(['[[Mara Quill]]']);
    expect(vault.properties(MEETING)).not.toHaveProperty('atlas_links');
  });

  it('is said by the rule’s dry run as not linked, and nothing is written', async () => {
    const { vault, state, importer, dryRun, link } = setUp();
    state.broken = true;
    await importer.catchUp(VAULT);
    state.broken = false;
    const before = vault.files.get(MEETING);

    const plan = await dryRun();

    expect(plan.notLinked).toEqual({ paths: [MEETING], capped: false });
    expect(describePlan(plan)).toContain('1 meeting is not linked: Run now links it first.');
    expect(link).not.toHaveBeenCalled();
    expect(vault.files.get(MEETING)).toBe(before);
  });

  it('is linked by Run now, its mark taken out, and Claude is asked about it linked', async () => {
    const { vault, state, importer, runNow, asked } = setUp();
    state.broken = true;
    await importer.catchUp(VAULT);
    state.broken = false;

    const entry = await runNow();

    // Linked before Claude was asked: the meeting it read already names its people.
    expect(asked()).toHaveLength(1);
    expect(JSON.stringify(asked()[0])).toContain('Mara Quill]]');

    expect(vault.properties(MEETING)['people']).toEqual(['[[Mara Quill]]']);
    expect(vault.properties(MEETING)).not.toHaveProperty('atlas_links');
    expect(vault.properties(MEETING)['atlas_import_outcome']).toBe('imported');
    expect(entry.kind).toBe('run');
  });

  it('links nothing twice: a second Run now does not link it again', async () => {
    const { vault, state, importer, runNow, link, dryRun } = setUp();
    state.broken = true;
    await importer.catchUp(VAULT);
    state.broken = false;
    await runNow();
    expect(link).toHaveBeenCalledTimes(1);
    const written = writesTo(vault, MEETING);

    await runNow();

    expect(link).toHaveBeenCalledTimes(1);
    expect(written).toEqual([]);
    expect(vault.properties(MEETING)['people']).toEqual(['[[Mara Quill]]']);
    expect((await dryRun()).notLinked).toBeUndefined();
  });

  it('keeps its mark when linking fails again, for the next Run now', async () => {
    const { vault, state, importer, runNow, link } = setUp();
    state.broken = true;
    await importer.catchUp(VAULT);

    await runNow();

    expect(link).toHaveBeenCalledTimes(1);
    expect(vault.properties(MEETING)['atlas_links']).toBe('failed');
  });
});

describe('a meeting already linked', () => {
  it('is untouched by Run now, even with a person taken out of its people', async () => {
    const linked = meetingFile({
      ...MEETING_HEADER,
      atlas_import_outcome: 'imported',
      people: [],
    });
    const { vault, runNow, link } = setUp({ [MEETING]: linked });

    await runNow();

    expect(link).not.toHaveBeenCalled();
    expect(vault.properties(MEETING)['people']).toEqual([]);
  });
});

describe('relinkMeetings', () => {
  const marked = meetingFile({
    ...MEETING_HEADER,
    atlas_import_outcome: 'imported',
    atlas_links: 'failed',
  });

  it('keeps the mark of a meeting the linker left: it is tried again next time', async () => {
    const vault = automationVault({ notes: { [MEETING]: marked }, today: TODAY });
    const meeting = createVaultPath(MEETING);
    const outcome = await relinkMeetings({
      link: async () => [
        {
          meeting,
          linked: [],
          filed: null,
          done: [],
          proposed: [],
          left: [
            { path: meeting, reason: 'Its people has changed since, so it was left as it is.' },
          ],
          passedOver: [],
          unproposed: null,
        },
      ],
      paths: [meeting],
      ports: vault.ports,
      today: TODAY,
    });

    expect(outcome).toEqual({ linked: [], notLinked: [MEETING] });
    expect(vault.properties(MEETING)['atlas_links']).toBe('failed');
  });

  it('keeps the mark of a meeting the linker gave no run for', async () => {
    const vault = automationVault({ notes: { [MEETING]: marked }, today: TODAY });
    const meeting = createVaultPath(MEETING);

    const outcome = await relinkMeetings({
      link: async () => [],
      paths: [meeting],
      ports: vault.ports,
      today: TODAY,
    });

    expect(outcome).toEqual({ linked: [], notLinked: [MEETING] });
    expect(vault.properties(MEETING)['atlas_links']).toBe('failed');
  });

  it('keeps the mark while the meeting has unsaved typing', async () => {
    const vault = automationVault({ notes: { [MEETING]: marked }, today: TODAY, dirty: [MEETING] });
    const meeting = createVaultPath(MEETING);

    const outcome = await relinkMeetings({
      link: async () => [
        {
          meeting,
          linked: [],
          filed: null,
          done: [],
          proposed: [],
          left: [],
          passedOver: [],
          unproposed: null,
        },
      ],
      paths: [meeting],
      ports: vault.ports,
      today: TODAY,
    });

    expect(outcome.notLinked).toEqual([MEETING]);
    expect(vault.properties(MEETING)['atlas_links']).toBe('failed');
  });

  it('asks nothing of the linker with no meetings', async () => {
    const vault = automationVault({ notes: {}, today: TODAY });
    const link = vi.fn(async () => []);

    expect(await relinkMeetings({ link, paths: [], ports: vault.ports, today: TODAY })).toEqual({
      linked: [],
      notLinked: [],
    });
    expect(link).not.toHaveBeenCalled();
  });
});

/** A meeting let in with the mark, as the import leaves one whose linking failed. */
const markedMeeting = (fields: Record<string, unknown> = {}) =>
  meetingFile({
    ...MEETING_HEADER,
    atlas_import_outcome: 'imported',
    atlas_links: 'failed',
    ...fields,
  });

describe('review of #192: a re-link that wrote something settles the meeting', () => {
  const LARKSPUR = 'Companies/Larkspur Payroll.md';
  const atLarkspur = {
    attendees: [
      { name: 'Mara Quill', email: 'mara.quill@example.com' },
      { name: 'Ada Venn', email: 'ada@larkspur.example' },
    ],
    // Something other than links the owner wrote: linking cannot add to it, and says so.
    people: [{ name: 'Mara and Ada' }],
  };

  it('takes the mark out when it linked a company but had to leave the people', async () => {
    const { vault, runNow } = setUp({
      [MEETING]: markedMeeting(atLarkspur),
      [LARKSPUR]: jsonNote({ type: 'company', domains: ['larkspur.example'] }),
    });

    await runNow();

    expect(vault.properties(MEETING)['companies']).toEqual(['[[Larkspur Payroll]]']);
    expect(vault.properties(MEETING)).not.toHaveProperty('atlas_links');
  });

  it('does not add back a company the owner took out after a partial re-link', async () => {
    const { vault, runNow } = setUp({
      [MEETING]: markedMeeting(atLarkspur),
      [LARKSPUR]: jsonNote({ type: 'company', domains: ['larkspur.example'] }),
    });
    await runNow();
    const { companies: _taken, ...rest } = vault.properties(MEETING);
    vault.files.set(MEETING, jsonNote(rest, '\n## Summary\n'));

    await runNow();

    expect(vault.properties(MEETING)['companies']).toBeUndefined();
  });

  it('takes the mark out in the write that links, so a pane dirtied after it cannot keep it', async () => {
    const { vault, runNow } = setUp({ [MEETING]: markedMeeting() });
    const state = vault.ports.editors.state.bind(vault.ports.editors);
    let wrote = false;
    const write = vault.ports.fs.writeTextFile;
    vault.ports.fs.writeTextFile = async (args) => {
      if (args.path === MEETING) wrote = true;
      return write(args);
    };
    // The owner starts typing in the meeting the moment its links land.
    vault.ports.editors.state = (path) => (wrote && path === MEETING ? 'dirty' : state(path));

    await runNow();

    expect(vault.properties(MEETING)['people']).toEqual(['[[Mara Quill]]']);
    expect(vault.properties(MEETING)).not.toHaveProperty('atlas_links');
  });
});

describe('review of #192: the import marks what the re-link would call unsettled', () => {
  it('marks a meeting whose linking ran but left the meeting with nothing written', async () => {
    const meeting = createVaultPath(MEETING);
    const said = await linkBeforeLetIn({
      linker: async () => [
        {
          meeting,
          linked: [],
          filed: null,
          done: [],
          proposed: [],
          left: [
            { path: meeting, reason: 'Its people has changed since, so it was left as it is.' },
          ],
          passedOver: [],
          unproposed: null,
        },
      ],
      vault: VAULT,
      path: meeting,
      reading: { vocabulary: { terms: [] } as never },
    });

    expect(said).toEqual({ stamp: { atlas_links: 'failed' } });
  });
});

describe('review of #192: re-linking writes only through the linker', () => {
  it('writes nothing itself once the linker is done, so a vault opened since keeps its notes', async () => {
    const vault = automationVault({ notes: { [MEETING]: markedMeeting() }, today: TODAY });
    const meeting = createVaultPath(MEETING);
    const written: string[] = [];
    const write = vault.ports.fs.writeTextFile;
    vault.ports.fs.writeTextFile = async (args) => {
      written.push(args.path);
      return write(args);
    };

    await relinkMeetings({
      // The linker linked it in the vault it was for; the vault open now is another.
      link: async () => [
        {
          meeting,
          linked: [],
          filed: null,
          done: [],
          proposed: [],
          left: [],
          passedOver: [],
          unproposed: null,
        },
      ],
      paths: [meeting],
      ports: vault.ports,
      today: TODAY,
    });

    expect(written).toEqual([]);
  });

  it('links nothing once another vault is open before the linker reaches the meeting', async () => {
    const vault = automationVault({ notes: { [MEETING]: markedMeeting() }, today: TODAY });
    const linker = createMeetingLinker({
      ports: () => vault.ports,
      clock: CLOCK,
      activity: recordingActivity(),
      openVault: () => '/vaults/other',
      selfName: () => null,
      selfEmails: () => [],
      onWritten: () => undefined,
    });

    const outcome = await relinkMeetings({
      link: (paths) => linker(VAULT, paths),
      paths: [createVaultPath(MEETING)],
      ports: vault.ports,
      today: TODAY,
    });

    expect(outcome).toEqual({ linked: [], notLinked: [MEETING] });
    expect(vault.properties(MEETING)['atlas_links']).toBe('failed');
  });
});

describe('review of #192: only a run by hand re-links', () => {
  it.each(['schedule', 'note'] as const)(
    'a run on %s does not link a marked meeting',
    async (trigger) => {
      const { vault, run, link } = setUp({ [MEETING]: markedMeeting() });

      await run(trigger).catch(() => undefined);

      expect(link).not.toHaveBeenCalled();
      expect(vault.properties(MEETING)['atlas_links']).toBe('failed');
    },
  );
});

describe('review of #192: finding the meetings not linked', () => {
  const ports = (vault: ReturnType<typeof automationVault>) => ({
    ...vault.ports,
    notePaths: [...vault.files.keys()],
  });
  const many = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, at) => [
        `Inbox/Meetings/2026-10-06 Sync ${String(at).padStart(3, '0')}.md`,
        markedMeeting({ external_id: `gemini-${at}` }),
      ]),
    );

  it('reads no meeting file when the index holds no mark', async () => {
    const vault = automationVault({
      notes: { [MEETING]: meetingFile({ ...MEETING_HEADER, atlas_import_outcome: 'imported' }) },
      today: TODAY,
      types: TYPES,
    });
    const readNotes = vi.spyOn(vault.ports.fs, 'readNotes');

    expect(await meetingsNotLinked({ ports: ports(vault), rule: RULE, today: TODAY })).toBeNull();
    expect(readNotes).not.toHaveBeenCalled();
  });

  it('takes at most fifty a run, and says more wait', async () => {
    const vault = automationVault({ notes: many(51), today: TODAY, types: TYPES });

    const found = await meetingsNotLinked({ ports: ports(vault), rule: RULE, today: TODAY });

    expect(found?.paths).toHaveLength(50);
    expect(found?.capped).toBe(true);
  });

  it('leaves out a meeting gone since the index answered', async () => {
    const vault = automationVault({ notes: many(2), today: TODAY, types: TYPES });
    const [gone, kept] = [...vault.files.keys()].filter((path) => path.startsWith('Inbox/'));
    const readNotes = vault.ports.fs.readNotes.bind(vault.ports.fs);
    vault.ports.fs.readNotes = async (paths) =>
      (await readNotes(paths)).filter((file) => file.path !== gone);

    const found = await meetingsNotLinked({ ports: ports(vault), rule: RULE, today: TODAY });

    expect(found).toEqual({ paths: [kept], capped: false });
  });
});
