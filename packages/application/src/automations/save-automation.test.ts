import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_PRESETS,
  builtInPromptAt,
  logPathFor,
  MEETING_EXTRACTION_PROMPT,
  parseRunLog,
  type AutomationDraft,
} from '@dfai/domain';
import { automationVault, jsonNote } from '../testing/automation-vault.ts';
import { loadAutomations } from './load-automations.ts';
import { runAutomation } from './run-automation.ts';
import { UnclosedFrontmatterError } from '../query/set-property.ts';
import { adoptAutomations } from './adopt-automations.ts';
import { AutomationRefusedError, createAutomation, updateAutomation } from './save-automation.ts';
import { recordingActivity } from '../testing/fake-activity.ts';

/** Where the runs say how they went; these tests read the rule's own log instead. */
const ACTIVITY = recordingActivity();

const TODAY = '2026-09-27';
const CLOCK = {
  today: () => TODAY,
  localNow: () => `${TODAY}T14:00:00`,
  now: () => Date.parse(`${TODAY}T14:00:00Z`),
};
const PRESET = AUTOMATION_PRESETS[0]!;
const PRESET_PATH = '.atlas/automations/Archive done tasks after 30 days.md';

function emptyVault(notes: Record<string, string> = {}) {
  return automationVault({ today: TODAY, notes });
}

async function create(vault: ReturnType<typeof emptyVault>, draft: AutomationDraft = PRESET) {
  const { fs, markdown } = vault.ports;
  return createAutomation({ fs, markdown, clock: CLOCK, draft, takenPaths: vault.ports.notePaths });
}

async function load(vault: ReturnType<typeof emptyVault>) {
  const { fs, markdown, notePaths } = vault.ports;
  return loadAutomations({ fs, markdown, notePaths });
}

describe('createAutomation', () => {
  it('writes the rule as a note that reads back as it, and logs it as turned on', async () => {
    const vault = emptyVault();
    const path = await create(vault);
    expect(path).toBe(PRESET_PATH);
    expect(vault.files.get(path)).toMatch(/\n# Archive done tasks after 30 days\n$/);
    const listing = await load(vault);
    expect(listing.automations.map((loaded) => loaded.rule)).toEqual([
      { ...PRESET, id: PRESET.name, path },
    ]);
    expect(listing.automations[0]?.log).toEqual([{ kind: 'turnedOn', at: `${TODAY}T14:00:00` }]);
  });

  it('logs nothing for a rule that starts out off', async () => {
    const vault = emptyVault();
    await create(vault, { ...PRESET, enabled: false });
    expect(vault.files.has(logPathFor(PRESET.name))).toBe(false);
  });

  it.each<[string, AutomationDraft, RegExp]>([
    ['a taken name', PRESET, /already an automation called/],
    ['no query', { ...PRESET, name: 'Other', which: '' }, /Say which notes/],
    ['a name a file cannot have', { ...PRESET, name: 'a/b' }, /cannot hold/],
  ])('refuses %s, writing nothing', async (_, draft, problem) => {
    const vault = emptyVault({ [PRESET_PATH]: jsonNote({ atlas: 'automation' }) });
    const before = [...vault.log];
    await expect(create(vault, draft)).rejects.toThrow(problem);
    await expect(create(vault, draft)).rejects.toBeInstanceOf(AutomationRefusedError);
    expect(vault.log).toEqual(before);
  });
});

describe('updateAutomation', () => {
  it('rewrites the rule, keeping the note’s own words, and logs turning it back on', async () => {
    const vault = emptyVault();
    const path = await create(vault, { ...PRESET, enabled: false });
    vault.files.set(path, `${vault.files.get(path)}\nMy reasons for this rule.\n`);
    const [{ rule } = { rule: null }] = (await load(vault)).automations;
    const { fs, markdown } = vault.ports;
    await updateAutomation({
      fs,
      markdown,
      clock: CLOCK,
      rule: rule!,
      draft: { ...rule!, enabled: true, olderThanDays: 14, when: { kind: 'hourly', every: 6 } },
    });
    const [after] = (await load(vault)).automations;
    expect(after?.rule).toMatchObject({
      enabled: true,
      olderThanDays: 14,
      when: { kind: 'hourly', every: 6 },
    });
    expect(vault.files.get(path)).toContain('My reasons for this rule.');
    expect(after?.log.map((entry) => entry.kind)).toEqual(['turnedOn']);
  });

  it('refuses a draft that is not a rule, and leaves the file alone', async () => {
    const vault = emptyVault();
    const path = await create(vault);
    const text = vault.files.get(path);
    const [{ rule } = { rule: null }] = (await load(vault)).automations;
    const { fs, markdown } = vault.ports;
    const write = (draft: AutomationDraft) =>
      updateAutomation({ fs, markdown, clock: CLOCK, rule: rule!, draft });
    await expect(write({ ...rule!, name: ' ' })).rejects.toThrow('Name the automation.');
    await expect(write({ ...rule!, which: '' })).rejects.toThrow(/Say which notes/);
    expect(vault.files.get(path)).toBe(text);
  });
});

/** A rule file with its closing `---` deleted by hand after it was read (#683). */
const unclosed = (text: string) => text.replace(/\n---\n/, '\n');

describe('a rule file whose block stops closing after it was read (#683)', () => {
  it('updateAutomation writes nothing over it, and says why', async () => {
    const vault = emptyVault();
    const path = await create(vault);
    const [{ rule } = { rule: null }] = (await load(vault)).automations;
    const broken = unclosed(vault.files.get(path) ?? '');
    vault.files.set(path, broken);
    const { fs, markdown } = vault.ports;
    await expect(
      updateAutomation({
        fs,
        markdown,
        clock: CLOCK,
        rule: rule!,
        draft: { ...rule!, enabled: false },
      }),
    ).rejects.toThrow(UnclosedFrontmatterError);
    expect(vault.files.get(path)).toBe(broken);
  });

  it('adoptAutomations leaves it as it is, and still stamps the rule beside it', async () => {
    const vault = emptyVault({
      '.atlas/automations/Tidy.md': jsonNote({
        atlas: 'automation',
        name: 'Tidy',
        when: 'manually',
        which: 'FROM task',
        do: 'archive',
        enabled: true,
      }),
      '.atlas/automations/Sweep.md': jsonNote({
        atlas: 'automation',
        name: 'Sweep',
        when: 'manually',
        which: 'FROM task',
        do: 'archive',
        enabled: true,
      }),
    });
    const listing = await load(vault);
    const broken = unclosed(vault.files.get('.atlas/automations/Sweep.md') ?? '');
    vault.files.set('.atlas/automations/Sweep.md', broken);
    const { fs, markdown } = vault.ports;
    await adoptAutomations({ fs, markdown, clock: CLOCK, listing });
    expect(vault.files.get('.atlas/automations/Sweep.md')).toBe(broken);
    expect(vault.properties('.atlas/automations/Tidy.md')['id']).toBe('Tidy');
  });
});

describe('loadAutomations', () => {
  it('lists rules by name with their logs, broken ones with why, and skips other notes', async () => {
    const vault = emptyVault({
      '.atlas/automations/Zed.md': jsonNote({
        atlas: 'automation',
        when: 'manually',
        which: 'FROM task',
        do: 'archive',
      }),
      '.atlas/automations/Broken.md': jsonNote({
        atlas: 'automation',
        when: 'weekly',
        which: 'FROM task',
        do: 'archive',
      }),
      '.atlas/automations/Readme.md': jsonNote({ title: 'Not a rule' }),
      '.atlas/automations/log/Zed.md': 'not a rule either',
      'Tasks/Old.md': jsonNote({ type: 'task', status: 'done' }),
    });
    await create(vault);
    const listing = await load(vault);
    expect(listing.automations.map((loaded) => loaded.rule.name)).toEqual([
      'Archive done tasks after 30 days',
      'Zed',
    ]);
    expect(listing.broken).toEqual([
      {
        path: '.atlas/automations/Broken.md',
        name: 'Broken',
        problem: expect.stringMatching(/Say when it runs/),
      },
    ]);
  });

  it('reads the log a run writes', async () => {
    const vault = emptyVault({ 'Tasks/Old.md': jsonNote({ type: 'task', status: 'done' }) });
    await create(vault, { ...PRESET, olderThanDays: null });
    const [{ rule } = { rule: null }] = (await load(vault)).automations;
    const guard = { vault: '/v', currentVault: () => '/v' };
    await runAutomation({
      ports: vault.ports,
      rule: rule!,
      clock: CLOCK,
      activity: ACTIVITY,
      guard,
      trigger: 'hand',
    });
    const [loaded] = (await load(vault)).automations;
    expect(loaded?.log.map((entry) => entry.kind)).toEqual(['turnedOn', 'run']);
    expect(parseRunLog(vault.files.get(logPathFor(rule!.id))!)).toEqual(loaded?.log);
  });
});

describe('a ready-made rule whose prompt DFAI ships (P29-05)', () => {
  const EXTRACTION = AUTOMATION_PRESETS.find((preset) => preset.action.kind === 'claude')!;
  const SHIPPED = builtInPromptAt(MEETING_EXTRACTION_PROMPT)!.contents;

  it('writes the prompt with the rule, so the rule runs as saved', async () => {
    const vault = emptyVault();

    const path = await create(vault, EXTRACTION);

    expect(vault.files.get(MEETING_EXTRACTION_PROMPT)).toBe(SHIPPED);
    const [loaded] = (await load(vault)).automations;
    expect(loaded?.rule).toEqual({ ...EXTRACTION, id: EXTRACTION.name, path });
  });

  it('never writes over a prompt that is there: it is the person’s, edited or not', async () => {
    const mine = 'Only what I promised.\n';
    const vault = emptyVault({ [MEETING_EXTRACTION_PROMPT]: mine });

    await create(vault, EXTRACTION);

    expect(vault.files.get(MEETING_EXTRACTION_PROMPT)).toBe(mine);
  });

  it('keeps a prompt written in the moment between the check and the write, and fails on any other error', async () => {
    const raced = emptyVault();
    const { fs, markdown } = raced.ports;
    const draft = { ...EXTRACTION, name: 'Raced' };
    const racing = {
      ...fs,
      createNote: async (note: { path: string; contents: string }) => {
        if (note.path === MEETING_EXTRACTION_PROMPT) {
          raced.files.set(note.path, 'Written by a sync.\n');
          throw new Error('that file already exists');
        }
        return fs.createNote(note as Parameters<typeof fs.createNote>[0]);
      },
    } as typeof fs;

    await createAutomation({ fs: racing, markdown, clock: CLOCK, draft, takenPaths: [] });

    expect(raced.files.get(MEETING_EXTRACTION_PROMPT)).toBe('Written by a sync.\n');
    const broken = emptyVault();
    const failing = {
      ...broken.ports.fs,
      createNote: async () => {
        throw new Error('disk full');
      },
    } as typeof fs;
    await expect(
      createAutomation({ fs: failing, markdown, clock: CLOCK, draft, takenPaths: [] }),
    ).rejects.toThrow('disk full');
  });

  it('writes it when a rule is edited to name it, and nothing for a prompt DFAI does not ship', async () => {
    const vault = emptyVault();
    const own = {
      ...EXTRACTION,
      name: 'Mine',
      action: { ...EXTRACTION.action, prompt: '.atlas/prompts/mine.md' },
    } as AutomationDraft;
    await create(vault, own);
    expect([...vault.files.keys()].filter((at) => at.startsWith('.atlas/prompts/'))).toEqual([]);
    const [loaded] = (await load(vault)).automations;
    const { fs, markdown } = vault.ports;

    await updateAutomation({
      fs,
      markdown,
      clock: CLOCK,
      rule: loaded!.rule,
      draft: { ...EXTRACTION, name: 'Mine' },
    });

    expect(vault.files.get(MEETING_EXTRACTION_PROMPT)).toBe(SHIPPED);
  });

  it('writes no prompt for a rule that asks Claude nothing', async () => {
    const vault = emptyVault();

    await create(vault);

    expect([...vault.files.keys()].some((at) => at.startsWith('.atlas/prompts/'))).toBe(false);
  });
});
