// @vitest-environment jsdom
/**
 * While the vault's settings note cannot be read, who the owner is is not
 * known, so the meeting import is held (#226) — and that is said, on the
 * Inbox and once in Activity, not left silent. Once the note reads again the
 * notice goes and the held meetings import. Wired as app.tsx wires it. All
 * names are made up. No node:sqlite: the index is faked.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, digestOf, type NoteChange } from '@dfai/domain';
import {
  createNoteChanges,
  fakeIndexPort,
  fakeVaultFs,
  readsTouchedByPaths,
  recordingActivity,
  type MeetingImportPorts,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useMeetingImport } from '../meetings/use-meeting-import.ts';
import { useProfileSetting } from './use-profile-setting.ts';
import { useSelfEmailsSetting } from './use-self-emails-setting.ts';
import { pausedMessage, RESUMED_MESSAGE, useSettingsPause } from './use-settings-pause.ts';
import { settingsUnreadable, vaultOwnerKnown } from './vault-owner-known.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { createReadInvalidator } from '../reads/read-invalidator.ts';

const VAULT = '/Users/mara/Vault';
const SETTINGS = '.atlas/settings.md';
const MEETING = 'Inbox/Meetings/2026-10-14 Renewal review.md';
const MEETING_TEXT = '---\ntype: meeting\natlas_import: meeting/v1\n---\n\nNotes.\n';
const ARRIVED: NoteChange = {
  kind: 'added',
  path: MEETING,
  type: 'meeting',
  digest: digestOf(MEETING_TEXT),
};
const BROKEN = '---\nprofileName: Mara Quill\nselfEmails: [mara.quill@example.com\n---\n';
const READABLE = '---\nprofileName: Mara Quill\nselfEmails: [mara.quill@example.com]\n---\n';

/** One each, as the window holds them: a new object each render would start the import over. */
const CLOCK = { today: () => '2026-10-14' };
const NOT_SYNCED = {
  standing: { kind: 'not-synced' as const },
  acts: async () => true,
  countGate: async () => ({ open: false as const, why: 'not-synced' as const }),
};
const NOTHING = () => undefined;

const folder = (path: string, name: string) => ({
  kind: 'directory' as const,
  name,
  path: createVaultPath(path),
});

/** A vault whose settings note reads as `settings.text` does now, with one meeting waiting to be imported. */
function vaultOf(settings: { text: string }, written: string[]): MeetingImportPorts {
  return {
    fs: fakeVaultFs({
      readNotes: async (paths) =>
        paths.includes(SETTINGS)
          ? [{ path: SETTINGS, text: settings.text, modified: 1, size: settings.text.length }]
          : [],
      listDirectory: async (path) =>
        path === ''
          ? [folder('Inbox', 'Inbox')]
          : path === 'Inbox'
            ? [folder('Inbox/Meetings', 'Meetings')]
            : [
                {
                  kind: 'file',
                  name: '2026-10-14 Renewal review.md',
                  path: createVaultPath(MEETING),
                },
              ],
      readTextFile: async () => ({ text: MEETING_TEXT, modified: 1 }),
      writeTextFile: async ({ path }) => {
        written.push(path);
        return 2;
      },
    }),
    index: fakeIndexPort(),
    markdown: remarkMarkdown,
    editors: {
      state: () => 'closed',
      flush: async () => undefined,
      follow: () => undefined,
      abandon: () => undefined,
      reload: () => undefined,
    },
  };
}

function render(settings: { text: string }) {
  const written: string[] = [];
  const ports = vaultOf(settings, written);
  const changes = createNoteChanges({ onError: () => undefined });
  const activity = recordingActivity();
  const { wrapper, client } = queryWrapper();
  const reads = createReadInvalidator({ client });
  const hook = renderHook(
    ({ changeKey, indexReady }: { changeKey: string; indexReady: boolean }) => {
      const profile = useProfileSetting({
        fs: ports.fs,
        markdown: remarkMarkdown,
        vaultKey: VAULT,
        activity,
      });
      const emails = useSelfEmailsSetting({
        fs: ports.fs,
        markdown: remarkMarkdown,
        index: ports.index,
        vaultKey: VAULT,
        changeKey,
        indexReady,
        activity,
      });
      const ownerKnown = vaultOwnerKnown(profile, emails);
      const unreadable = settingsUnreadable(profile);
      useSettingsPause({ unreadable, vaultKey: VAULT, activity });
      useMeetingImport({
        changes,
        ports,
        clock: CLOCK,
        activity,
        vaultKey: VAULT,
        selfName: profile.profile === 'unknown' ? null : profile.profile.name,
        selfEmails: emails.emails,
        ownerKnown,
        active: true,
        indexReady,
        pulledFiles: NOT_SYNCED,
        namedElsewhere: null,
        onWaiting: () => undefined,
        onWritten: NOTHING,
      });
      return { profile, ownerKnown, unreadable };
    },
    // The index is built after the window opens, as in the app.
    { wrapper, initialProps: { changeKey: '0', indexReady: false } },
  );
  hook.rerender({ changeKey: '0', indexReady: true });
  return { ...hook, changes, activity, written, reads };
}

const said = (activity: ReturnType<typeof recordingActivity>) =>
  activity.reports.map(({ message }) => message);

describe('meetings and automations while the settings note cannot be read (#226)', () => {
  it('holds the import and says so once, then imports what waited once the note reads', async () => {
    const settings = { text: BROKEN };
    const { result, rerender, changes, activity, written, reads } = render(settings);

    await waitFor(() => expect(result.current.unreadable).not.toBeNull());
    expect(result.current.ownerKnown).toBe(false);
    changes.publish({ vault: VAULT, changes: [ARRIVED] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(written).toEqual([]);
    const paused = said(activity).filter((message) =>
      message.startsWith('Meetings and automations are paused'),
    );
    expect(paused).toEqual([pausedMessage(result.current.unreadable!)]);
    expect(paused[0]).toContain('.atlas/settings.md can’t be read');

    // Read again, unchanged — a read that failed is read again on the index's news: said once, not each time.
    rerender({ changeKey: '1', indexReady: true });
    act(() => reads.indexMoved(VAULT));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      said(activity).filter((message) => message.startsWith('Meetings and automations are paused')),
    ).toHaveLength(1);

    settings.text = READABLE;
    act(() => reads.invalidate(VAULT, readsTouchedByPaths(['.atlas/settings.md'])));
    rerender({ changeKey: '2', indexReady: true });

    await waitFor(() => expect(result.current.unreadable).toBeNull());
    expect(result.current.ownerKnown).toBe(true);
    await waitFor(() => expect(written).toEqual([MEETING]));
    expect(said(activity)).toContain(RESUMED_MESSAGE);
  });

  it('says nothing of a pause while the note reads', async () => {
    const { result, activity } = render({ text: READABLE });

    await waitFor(() => expect(result.current.ownerKnown).toBe(true));
    expect(result.current.unreadable).toBeNull();
    expect(
      said(activity).filter((message) => message.startsWith('Meetings and automations')),
    ).toEqual([]);
  });
});
