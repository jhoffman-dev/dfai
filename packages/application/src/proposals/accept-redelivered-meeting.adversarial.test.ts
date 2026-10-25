/**
 * Adversarial pass over the meeting a proposal came from (P29-04, ADR-0027
 * "A proposal is input, and the meeting it names is found by what it is"):
 * the meeting is filed, and the same meeting is then delivered again at the
 * path it first landed at — the path the proposal still names. Over the fake
 * vault whose index answers with real SQL.
 *
 * Fails on p29-03.
 */
import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  importOutcomeOf,
  noteChangesBetween,
  type NoteVersion,
  type VaultPath,
} from '@dfai/domain';
import { heldEntries } from '../index/refresh-index.ts';
import { createMeetingLinker } from '../meeting-links/link-imported-meetings.ts';
import { createMeetingImporter } from '../meetings/meeting-importer.ts';
import { automationVault, jsonNote } from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { MEETING_HEADER } from '../testing/meeting-files.ts';
import { acceptProposalNote } from './accept-proposal.ts';

const TODAY = '2026-10-08';
const VAULT = '/vaults/home';
const MEETING = 'Inbox/Meetings/2026-10-06 Standup.md';
const FILED = 'Meetings/2026-10-06 Standup.md';

const BODY = ['', '## Transcript', '', '**Mara Quill** [~00:00:00] Morning. ^t0001', ''].join('\n');

/** Ines Abara is no one the vault knows, so linking proposes her as a person, to be linked from the meeting. */
const ARRIVING = jsonNote(
  { ...MEETING_HEADER, attendees: [{ name: 'Ines Abara', email: 'ines.abara@example.net' }] },
  BODY,
);

const relation = { kind: 'relation', target: 'person', many: true };
const NOTES = {
  'People/Mara Quill.md': jsonNote({ type: 'person' }, ''),
  '.atlas/types/meeting.md': jsonNote({ name: 'meeting', properties: { people: relation } }, ''),
  '.atlas/types/person.md': jsonNote({ name: 'person', properties: {} }, ''),
};

async function setUp() {
  const vault = automationVault({ notes: { ...NOTES }, today: TODAY });
  const activity = recordingActivity();
  const wiring = {
    ports: () => vault.ports,
    clock: { today: () => TODAY },
    activity,
    openVault: () => VAULT,
    onWritten: () => undefined,
  };
  const linker = createMeetingLinker({ ...wiring, selfName: () => null, selfEmails: () => [] });
  const importer = createMeetingImporter({
    ...wiring,
    active: () => true,
    beforeLetIn: async (vaultKey: string, path: VaultPath) => void (await linker(vaultKey, [path])),
  });
  const land = () =>
    vault.ports.fs.createNote({ path: createVaultPath(MEETING), contents: ARRIVING });
  const before = new Map<string, NoteVersion>(await heldEntries(vault.ports.index));
  await land();
  const changes = noteChangesBetween(before, await heldEntries(vault.ports.index));
  await importer.hear({ vault: VAULT, changes });
  const [proposal] = [...vault.files.keys()].filter((at) => at.startsWith('Inbox/Proposals/'));
  return { vault, land, proposal: createVaultPath(proposal ?? '') };
}

describe('accepting a proposal after its meeting was filed and delivered again', () => {
  it('writes nothing into the new delivery waiting at the old path, which the import has not let in', async () => {
    const { vault, land, proposal } = await setUp();
    await vault.ports.fs.createFolder({ path: createVaultPath('Meetings') });
    await vault.ports.fs.moveEntry({
      from: createVaultPath(MEETING),
      to: createVaultPath(FILED),
    });
    // The same meeting again, where it first landed: unstamped until the import archives it as a copy
    // (at once on the Mac that imports; never on a Mac that does not, where it waits as it is).
    await land();
    expect(importOutcomeOf(vault.properties(FILED))).toBe('imported');
    expect(importOutcomeOf(vault.properties(MEETING))).toBeNull();

    // Accepting may link her to the filed meeting or refuse; either way the copy is not the meeting.
    await acceptProposalNote({
      via: 'app',
      ports: vault.ports,
      path: proposal,
      today: TODAY,
    }).catch(() => undefined);

    expect(vault.properties(MEETING)['people']).toBeUndefined();
  });

  it('refuses, in words, when the only note holding the meeting is one the import has not let in', async () => {
    const { vault, land, proposal } = await setUp();
    // The meeting the import let in is gone; the same meeting is delivered again and waits unstamped.
    vault.files.delete(MEETING);
    await land();
    expect(importOutcomeOf(vault.properties(MEETING))).toBeNull();

    await expect(
      acceptProposalNote({ via: 'app', ports: vault.ports, path: proposal, today: TODAY }),
    ).rejects.toThrow(/has not been let in by the import yet/);

    expect(vault.properties(MEETING)['people']).toBeUndefined();
  });
});
