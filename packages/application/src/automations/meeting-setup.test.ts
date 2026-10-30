/**
 * The setup of meeting post-processing (#191, ADR-0036): one previewed yes
 * writes the "After a meeting" rule, its prompt, the Meeting and Task types'
 * keys and the owner's addresses — each skipped where it is there — and the
 * preview writes nothing. Over a vault in memory whose frontmatter is JSON
 * lines, so each file reads back whole; how the real writer keeps every byte
 * is the adapters'.
 */
import { describe, expect, it } from 'vitest';
import {
  AFTER_A_MEETING_PRESET,
  automationFrontmatter,
  builtInPromptAt,
  MEETING_EXTRACTION_PROPERTIES,
  MEETING_IMPORT_PROPERTIES,
  MEETING_SUMMARY_PROPERTIES,
  splitFrontmatter,
  type VaultPath,
} from '@dfai/domain';
import { loadSelfEmails } from '../profile/self-emails-setting.ts';
import { createSettingsWriter, type SettingsWriter } from '../settings/index.ts';
import { memoryVault } from '../testing/fake-git.ts';
import { fakeVaultFs } from '../testing/fake-ports.ts';
import { jsonLinesMarkdown, jsonLinesNote } from '../testing/proposal-vault.ts';
import { loadAutomations } from './load-automations.ts';
import { acceptMeetingSetup, previewMeetingSetup } from './meeting-setup.ts';
import type { VaultFsPort } from '../vault/ports.ts';

const DAY = '2026-10-30';
const CLOCK = { localNow: () => `${DAY}T09:00:00`, now: () => Date.parse(`${DAY}T09:00:00Z`) };

const RULE = '.atlas/automations/After a meeting.md';
const PROMPT = '.atlas/prompts/after-a-meeting.md';
const SETTINGS = '.atlas/settings.md';
const MEETING_TYPE = '.atlas/types/meeting.md';
const TASK_TYPE = '.atlas/types/task.md';

const MEETING = jsonLinesNote(
  { name: 'meeting', label: 'Meeting', properties: { date: 'date' } },
  '\n# Meeting\n',
);
const TASK = jsonLinesNote(
  { name: 'task', label: 'Task', properties: { status: 'text', size: 'text' } },
  '\n# Task\n\nMara’s own words about tasks.\n',
);

function vault(files: Record<string, string>) {
  const memory = memoryVault(files);
  const fs = fakeVaultFs({
    ...memory.fs,
    listNotes: async () =>
      [...memory.files.keys()]
        .filter((path) => path.endsWith('.md'))
        .map((path) => ({
          path: path as VaultPath,
          name: path.split('/').at(-1) ?? path,
          modified: 1,
          size: 0,
        })),
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const text = memory.files.get(path);
        return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
      }),
  });
  const markdown = jsonLinesMarkdown();
  const settings: SettingsWriter = createSettingsWriter({ fs, markdown });
  const propertiesOf = (path: string) => {
    const text = memory.files.get(path);
    if (text === undefined) return null;
    return markdown.frontmatterProperties(splitFrontmatter(text).frontmatter);
  };
  const declared = (path: string) =>
    Object.keys((propertiesOf(path)?.['properties'] ?? {}) as Record<string, unknown>);
  return { fs, markdown, settings, clock: CLOCK, files: memory.files, propertiesOf, declared };
}

type Vault = ReturnType<typeof vault>;

async function yes(v: Vault, emails = '') {
  const offer = await previewMeetingSetup(v);
  return acceptMeetingSetup({ ...v, offer, emails });
}

/** What a Meeting type gains: the import's keys, the step's links and the summary's keys. */
const MEETING_KEYS = [
  ...MEETING_IMPORT_PROPERTIES,
  ...MEETING_EXTRACTION_PROPERTIES,
  ...MEETING_SUMMARY_PROPERTIES,
].map((property) => property.key);

describe('previewMeetingSetup', () => {
  it('lists everything a vault with nothing set up gains, and writes nothing', async () => {
    const v = vault({ [MEETING_TYPE]: MEETING, [TASK_TYPE]: TASK });
    const before = new Map(v.files);
    const offer = await previewMeetingSetup(v);
    expect(v.files).toEqual(before);
    expect(offer.rule?.name).toBe('After a meeting');
    expect(offer.prompt).toBe(PROMPT);
    expect(offer.extensions.map((extension) => extension.before.path)).toEqual([
      MEETING_TYPE,
      TASK_TYPE,
    ]);
    expect(offer.asksEmails).toBe(true);
    expect(offer.lines.every((line) => line.written)).toBe(true);
  });
});

describe('acceptMeetingSetup', () => {
  it('in a fresh vault, writes the rule, its prompt, both types’ keys and the emails', async () => {
    const v = vault({ [MEETING_TYPE]: MEETING, [TASK_TYPE]: TASK });
    const done = await yes(v, 'Mara.Quill@example.com, mara@example.com');
    expect(done.failed).toEqual([]);
    expect(done.refused).toBeNull();
    expect(v.declared(MEETING_TYPE)).toEqual(['date', ...MEETING_KEYS]);
    expect(v.declared(TASK_TYPE)).toEqual(['status', 'size', 'meeting', 'atlas_item']);
    // The Task type's file keeps its own words.
    expect(v.files.get(TASK_TYPE)).toContain('Mara’s own words about tasks.');
    expect(v.files.get(PROMPT)).toBe(builtInPromptAt(PROMPT)?.contents);
    expect(v.propertiesOf(SETTINGS)?.['selfEmails']).toEqual([
      'mara.quill@example.com',
      'mara@example.com',
    ]);
    const listing = await loadAutomations({ ...v, notePaths: [RULE as VaultPath] });
    const [loaded] = listing.automations;
    expect(loaded?.rule).toMatchObject({ ...AFTER_A_MEETING_PRESET, path: RULE });
    expect(loaded?.log).toEqual([{ kind: 'turnedOn', at: `${DAY}T09:00:00` }]);
    expect(done.written).toEqual([
      `The Meeting type gained ${MEETING_KEYS.join(', ')}.`,
      'The Task type gained meeting, atlas_item.',
      `Wrote the prompt ${PROMPT}.`,
      'Saved your emails: mara.quill@example.com, mara@example.com.',
      'Turned on “After a meeting”.',
    ]);
  });

  it('says the rule is on after a yes that wrote it, and when it was already', async () => {
    const v = vault({ [MEETING_TYPE]: MEETING, [TASK_TYPE]: TASK });
    expect((await yes(v)).ruleOn).toBe(true);
    expect((await yes(v)).ruleOn).toBe(true);
  });

  it('says the rule is not on when writing it failed, though the rest was written', async () => {
    const v = vault({ [MEETING_TYPE]: MEETING, [TASK_TYPE]: TASK });
    const offer = await previewMeetingSetup(v);
    const refusing: VaultFsPort = {
      ...v.fs,
      createNote: async (create) => {
        if (create.path === RULE) throw new Error('The disk said no.');
        return v.fs.createNote(create);
      },
    };
    const done = await acceptMeetingSetup({ ...v, fs: refusing, offer, emails: '' });
    expect(done.ruleOn).toBe(false);
    expect(done.written).toContain('The Task type gained meeting, atlas_item.');
    expect(done.failed).toEqual([
      { what: 'The “After a meeting” rule', reason: 'The disk said no.' },
    ]);
  });

  it('says it wrote the prompt the rule needs when it went missing after the preview', async () => {
    const v = vault({ [MEETING_TYPE]: MEETING, [TASK_TYPE]: TASK, [PROMPT]: 'Mine.\n' });
    const offer = await previewMeetingSetup(v);
    expect(offer.prompt).toBeNull();
    v.files.delete(PROMPT);
    const done = await acceptMeetingSetup({ ...v, offer, emails: '' });
    expect(v.files.get(PROMPT)).toBe(builtInPromptAt(PROMPT)?.contents);
    expect(done.written).toContain(
      `Wrote the prompt ${PROMPT}, which the “After a meeting” rule names.`,
    );
  });

  it('a second yes duplicates nothing and writes nothing', async () => {
    const v = vault({ [MEETING_TYPE]: MEETING, [TASK_TYPE]: TASK });
    await yes(v, 'mara.quill@example.com');
    const after = new Map(v.files);
    const again = await previewMeetingSetup(v);
    expect(again.rule).toBeNull();
    expect(again.prompt).toBeNull();
    expect(again.extensions).toEqual([]);
    expect(again.asksEmails).toBe(false);
    expect(again.lines.some((line) => line.written)).toBe(false);
    const done = await acceptMeetingSetup({ ...v, offer: again, emails: 'other@example.com' });
    expect(done.written).toEqual([]);
    expect(v.files).toEqual(after);
  });

  it('a stale preview said yes to twice writes the rule and keys once', async () => {
    const v = vault({ [MEETING_TYPE]: MEETING, [TASK_TYPE]: TASK });
    const offer = await previewMeetingSetup(v);
    await acceptMeetingSetup({ ...v, offer, emails: '' });
    const after = new Map(v.files);
    const twice = await acceptMeetingSetup({ ...v, offer, emails: '' });
    expect(twice).toEqual({ written: [], failed: [], refused: null, ruleOn: true });
    expect(v.files).toEqual(after);
  });

  it('no: without the yes, previewing alone leaves the vault byte for byte', async () => {
    const files = { [MEETING_TYPE]: MEETING, [TASK_TYPE]: TASK };
    const v = vault(files);
    await previewMeetingSetup(v);
    await previewMeetingSetup(v);
    expect(Object.fromEntries(v.files)).toEqual(files);
  });

  it('in a partly set up vault, skips the rule, prompt and keys there and writes the rest', async () => {
    const ownPrompt = 'Mara’s own way of asking.\n';
    const ownRule = jsonLinesNote(
      { ...automationFrontmatter({ ...AFTER_A_MEETING_PRESET, name: 'Digest' }), id: 'Digest' },
      '\n# Digest\n',
    );
    const partMeeting = jsonLinesNote({
      name: 'meeting',
      label: 'Meeting',
      properties: { tasks: { kind: 'relation', target: 'task', many: true } },
    });
    const v = vault({
      '.atlas/automations/Digest.md': ownRule,
      [PROMPT]: ownPrompt,
      [MEETING_TYPE]: partMeeting,
      [TASK_TYPE]: TASK,
    });
    const offer = await previewMeetingSetup(v);
    expect(offer.rule).toBeNull();
    expect(offer.prompt).toBeNull();
    const done = await acceptMeetingSetup({ ...v, offer, emails: '' });
    expect(done.failed).toEqual([]);
    expect(v.files.get(PROMPT)).toBe(ownPrompt);
    expect(v.files.get('.atlas/automations/Digest.md')).toBe(ownRule);
    expect(v.files.has(RULE)).toBe(false);
    expect(v.declared(MEETING_TYPE)).toEqual([
      'tasks',
      ...MEETING_KEYS.filter((k) => k !== 'tasks'),
    ]);
    expect(v.declared(TASK_TYPE)).toContain('atlas_item');
    // No emails typed: none saved, and no settings note made for nothing.
    expect(v.files.has(SETTINGS)).toBe(false);
  });

  it('keeps addresses already saved, whatever is typed', async () => {
    const settings = jsonLinesNote({ selfEmails: ['mara.quill@example.com'] });
    const v = vault({ [SETTINGS]: settings, [MEETING_TYPE]: MEETING, [TASK_TYPE]: TASK });
    const offer = await previewMeetingSetup(v);
    expect(offer.asksEmails).toBe(false);
    await acceptMeetingSetup({ ...v, offer, emails: 'tobias.fenn@example.com' });
    expect(v.files.get(SETTINGS)).toBe(settings);
  });

  it('saves selfEmails so they read back, and moves Granola’s older key', async () => {
    const v = vault({
      [SETTINGS]: jsonLinesNote({ granola_self_emails: ['mara@example.com'], profileName: 'Mara' }),
      [MEETING_TYPE]: MEETING,
      [TASK_TYPE]: TASK,
    });
    await yes(v, 'mara.quill@example.com');
    const read = await loadSelfEmails(v);
    expect(read).toEqual({
      emails: ['mara.quill@example.com'],
      source: 'selfEmails',
      problem: null,
    });
    expect(v.propertiesOf(SETTINGS)).toEqual({
      profileName: 'Mara',
      selfEmails: ['mara.quill@example.com'],
    });
  });

  it('refuses the whole yes when what was typed is not all addresses, writing nothing', async () => {
    const files = { [MEETING_TYPE]: MEETING, [TASK_TYPE]: TASK };
    const v = vault(files);
    const done = await yes(v, 'mara.quill@example.com, not an address');
    expect(done.refused).toMatch(/Nothing was saved\.$/);
    expect(done.written).toEqual([]);
    expect(Object.fromEntries(v.files)).toEqual(files);
  });

  it('says what failed and still writes the rest', async () => {
    const v = vault({ [MEETING_TYPE]: MEETING, [TASK_TYPE]: TASK });
    const offer = await previewMeetingSetup(v);
    const refusing: VaultFsPort = {
      ...v.fs,
      writeTextFile: async (write) => {
        if (write.path === TASK_TYPE) throw new Error('The disk said no.');
        return v.fs.writeTextFile(write);
      },
    };
    const done = await acceptMeetingSetup({ ...v, fs: refusing, offer, emails: '' });
    expect(done.failed).toEqual([{ what: 'The Task type', reason: 'The disk said no.' }]);
    expect(done.written).toContain('Turned on “After a meeting”.');
    expect(v.declared(TASK_TYPE)).toEqual(['status', 'size']);
    expect(v.declared(MEETING_TYPE)).toContain('atlas_summary_digest');
  });

  it('says a failure that is not an Error as it was thrown', async () => {
    const v = vault({ [MEETING_TYPE]: MEETING, [TASK_TYPE]: TASK });
    const offer = await previewMeetingSetup(v);
    const refusing: SettingsWriter = {
      ...v.settings,
      save: () => Promise.reject('settings are locked'),
    };
    const done = await acceptMeetingSetup({
      ...v,
      settings: refusing,
      offer,
      emails: 'mara@example.com',
    });
    expect(done.failed).toEqual([{ what: 'Your email addresses', reason: 'settings are locked' }]);
  });
});
