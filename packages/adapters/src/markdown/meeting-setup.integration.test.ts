/**
 * The setup of meeting post-processing (#191) through the real YAML markdown
 * port: a rule file that cannot be read is the person's, listed as broken by
 * the Automations page, and neither throws the preview or the yes nor is
 * written over. The yes's own files read back as rules and types.
 */
import { describe, expect, it } from 'vitest';
import {
  acceptMeetingSetup,
  apiFixture,
  createSettingsWriter,
  listVaultNotes,
  loadAutomations,
  loadObjectTypes,
  previewMeetingSetup,
} from '@dfai/application';
import { remarkMarkdown } from './markdown-port.ts';

const CLOCK = {
  localNow: () => '2026-10-30T09:00:00',
  now: () => Date.parse('2026-10-30T09:00:00Z'),
};

const MEETING_TYPE = [
  '---',
  'name: meeting',
  'label: Meeting',
  'properties:',
  '  date: date',
  '---',
  '',
  '# Meeting',
  '',
].join('\n');

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status: text',
  '---',
  '',
  '# Task',
  '',
].join('\n');

/** A rule file whose frontmatter is not YAML: a hand edit gone wrong. */
const MALFORMED = ['---', 'atlas: automation', 'name: [Digest', 'when: : :', '---', ''].join('\n');
const MALFORMED_PATH = '.atlas/automations/Digest.md';
/** A rule file that reads as YAML but says something no rule can: listed as broken. */
const UNRUNNABLE = [
  '---',
  'atlas: automation',
  'name: Weekly digest',
  'when: whenever it likes',
  'which: FROM meeting',
  'do: archive',
  '---',
  '',
].join('\n');
const UNRUNNABLE_PATH = '.atlas/automations/Weekly digest.md';

function vault() {
  const fixture = apiFixture({
    files: {
      '.atlas/types/meeting.md': MEETING_TYPE,
      '.atlas/types/task.md': TASK_TYPE,
      [MALFORMED_PATH]: MALFORMED,
      [UNRUNNABLE_PATH]: UNRUNNABLE,
    },
    markdown: remarkMarkdown,
  });
  const { fs } = fixture;
  const ports = {
    fs,
    markdown: remarkMarkdown,
    clock: CLOCK,
    settings: createSettingsWriter({ fs, markdown: remarkMarkdown }),
  };
  return { fixture, ports };
}

describe('meeting setup through the real markdown port', () => {
  it('reads past rule files that are not YAML or cannot run, and sets meetings up beside them', async () => {
    const { fixture, ports } = vault();
    const offer = await previewMeetingSetup(ports);
    expect(offer.rule?.name).toBe('After a meeting');
    const done = await acceptMeetingSetup({ ...ports, offer, emails: 'mara.quill@example.com' });
    expect(done.failed).toEqual([]);
    expect(done.ruleOn).toBe(true);
    // The broken file is left as it was.
    expect(fixture.files.get(MALFORMED_PATH)?.text).toBe(MALFORMED);
    const listing = await loadAutomations({ ...ports, notePaths: await listVaultNotes(ports) });
    expect(listing.automations.map(({ rule }) => rule.name)).toEqual(['After a meeting']);
    // The rule that cannot run is listed as broken, as the Automations page shows it.
    expect(listing.broken.map(({ path }) => path)).toEqual([UNRUNNABLE_PATH]);
    expect(fixture.files.get(UNRUNNABLE_PATH)?.text).toBe(UNRUNNABLE);
    const [rule] = listing.automations;
    expect(rule?.rule.action).toMatchObject({ kind: 'claude', apply: 'mine' });
    const types = await loadObjectTypes(ports);
    const keysOf = (name: string) =>
      types.find((type) => type.name === name)?.properties.map((property) => property.key) ?? [];
    expect(keysOf('task')).toEqual(['status', 'meeting', 'atlas_item']);
    expect(keysOf('meeting')).toContain('atlas_summary_digest');
    expect(fixture.files.get('.atlas/settings.md')?.text).toContain('mara.quill@example.com');
  });

  it('a second yes through the real port writes nothing', async () => {
    const { fixture, ports } = vault();
    await acceptMeetingSetup({ ...ports, offer: await previewMeetingSetup(ports), emails: '' });
    const before = new Map([...fixture.files].map(([path, note]) => [path, note.text]));
    const again = await previewMeetingSetup(ports);
    const done = await acceptMeetingSetup({ ...ports, offer: again, emails: '' });
    expect(done.written).toEqual([]);
    expect(new Map([...fixture.files].map(([path, note]) => [path, note.text]))).toEqual(before);
  });
});
