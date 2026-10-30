/**
 * Adversarial pass on PR #643 (#191): what the yes says against what it wrote
 * when the vault moves between the preview and the yes, or a write fails
 * midway. Each `it.fails` is a bug found; the fix flips it to `it`.
 */
import { describe, expect, it } from 'vitest';
import { AFTER_A_MEETING_PRESET, automationFrontmatter, type VaultPath } from '@dfai/domain';
import { createSettingsWriter, type SettingsWriter } from '../settings/index.ts';
import { memoryVault } from '../testing/fake-git.ts';
import { fakeVaultFs } from '../testing/fake-ports.ts';
import { jsonLinesMarkdown, jsonLinesNote } from '../testing/proposal-vault.ts';
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
  { name: 'task', label: 'Task', properties: { status: 'text' } },
  '\n# Task\n',
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
  return { fs, markdown, settings, clock: CLOCK, files: memory.files };
}

/** Every sentence the yes said, written or failed, for asserting a part was mentioned at all. */
const said = (done: { written: readonly string[]; failed: readonly { what: string }[] }) => [
  ...done.written,
  ...done.failed.map(({ what }) => what),
];

describe('acceptMeetingSetup (attack #643)', () => {
  it.fails(
    'says the rule is on when its file was written, even if its turned-on log entry failed',
    async () => {
      const v = vault({ [MEETING_TYPE]: MEETING, [TASK_TYPE]: TASK });
      const offer = await previewMeetingSetup(v);
      const logRefused: VaultFsPort = {
        ...v.fs,
        createNote: async (create) => {
          if (create.path.includes('/log/')) throw new Error('The disk said no.');
          return v.fs.createNote(create);
        },
      };
      const done = await acceptMeetingSetup({ ...v, fs: logRefused, offer, emails: '' });
      // The rule file is on disk with enabled: true, so the runner will run it.
      expect(v.files.has(RULE)).toBe(true);
      expect(done.ruleOn).toBe(true);
    },
  );

  it.fails(
    'does not count a rule that never runs when a meeting arrives as processing meetings on arrival',
    async () => {
      const manual = { ...AFTER_A_MEETING_PRESET, name: 'Mara items', when: { kind: 'manual' } };
      const v = vault({
        '.atlas/automations/Mara items.md': jsonLinesNote(
          { ...automationFrontmatter(manual as typeof AFTER_A_MEETING_PRESET), id: 'mara-items' },
          '\n# Mara items\n',
        ),
        [MEETING_TYPE]: MEETING,
        [TASK_TYPE]: TASK,
      });
      const offer = await previewMeetingSetup(v);
      expect(offer.ruleOn).toBe(false);
    },
  );

  it.fails(
    'says why the shown rule was not written when its path was taken after the preview',
    async () => {
      const v = vault({ [MEETING_TYPE]: MEETING, [TASK_TYPE]: TASK });
      const offer = await previewMeetingSetup(v);
      expect(offer.rule).not.toBeNull();
      // A note of Mara's own syncs in at the rule's path while the preview waits.
      v.files.set(RULE, '# After a meeting\n\nMara’s notes on what to do after one.\n');
      const done = await acceptMeetingSetup({ ...v, offer, emails: '' });
      expect(done.failed.map(({ what }) => what)).toContain('The “After a meeting” rule');
    },
  );

  it.fails(
    'says the typed addresses were not saved when selfEmails was saved after the preview',
    async () => {
      const v = vault({ [MEETING_TYPE]: MEETING, [TASK_TYPE]: TASK });
      const offer = await previewMeetingSetup(v);
      expect(offer.asksEmails).toBe(true);
      v.files.set(SETTINGS, jsonLinesNote({ selfEmails: ['tobias.fenn@example.com'] }));
      const done = await acceptMeetingSetup({ ...v, offer, emails: 'mara.quill@example.com' });
      expect(said(done).some((line) => /email/i.test(line))).toBe(true);
    },
  );

  it.fails(
    'says why the shown Meeting keys were not written when a second file claimed the type',
    async () => {
      const v = vault({ [MEETING_TYPE]: MEETING, [TASK_TYPE]: TASK });
      const offer = await previewMeetingSetup(v);
      expect(offer.extensions.map(({ before }) => before.name)).toContain('meeting');
      v.files.set('.atlas/types/meeting-copy.md', MEETING);
      const done = await acceptMeetingSetup({ ...v, offer, emails: '' });
      expect(said(done).some((line) => line.startsWith('The Meeting type'))).toBe(true);
    },
  );

  it.fails('never reports the prompt both as failed and as written in one yes', async () => {
    const v = vault({ [MEETING_TYPE]: MEETING, [TASK_TYPE]: TASK });
    const offer = await previewMeetingSetup(v);
    let refusals = 1;
    const onceRefused: VaultFsPort = {
      ...v.fs,
      createNote: async (create) => {
        if (create.path === PROMPT && refusals-- > 0) throw new Error('Busy, try again.');
        return v.fs.createNote(create);
      },
    };
    const done = await acceptMeetingSetup({ ...v, fs: onceRefused, offer, emails: '' });
    const failedPrompt = done.failed.some(({ what }) => what.includes(PROMPT));
    const wrotePrompt = done.written.some((line) => line.includes(PROMPT));
    expect(failedPrompt && wrotePrompt).toBe(false);
  });
});
