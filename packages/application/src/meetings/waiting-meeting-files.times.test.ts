import { createVaultPath } from '@dfai/domain';
import { describe, expect, it } from 'vitest';
import { fakeMarkdown, fakeVaultFs } from '../testing/index.ts';
import type { NoteContents } from '../vault/ports.ts';
import { readWaitingMeetings } from './waiting-meeting-files.ts';

const MEETING = createVaultPath('Inbox/Meetings/2026-10-30 Larkspur sync.md');

const readAs = async (contents: NoteContents) =>
  (
    await readWaitingMeetings(
      { fs: fakeVaultFs({ readTextFile: async () => contents }), markdown: fakeMarkdown() },
      [MEETING],
    )
  )[0]?.read?.modifiedAt;

/** #720 (ADR-0053): a waiting meeting is dated by when it was written, never by its version. */
describe('readWaitingMeetings: when a meeting was written', () => {
  it('is unknown where the vault cannot tell, whatever its version', async () => {
    expect(await readAs({ text: 'Notes.\n', modified: 5, modifiedAt: null })).toBeNull();
  });

  it('is the host’s time where it gives one', async () => {
    expect(await readAs({ text: 'Notes.\n', modified: 1_000 })).toBe(1_000);
  });
});
