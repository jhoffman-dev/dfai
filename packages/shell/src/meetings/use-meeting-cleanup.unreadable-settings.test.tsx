// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import { fakeIndexPort, fakeVaultFs, recordingActivity, type QueryResult } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useProfileSetting } from '../profile/use-profile-setting.ts';
import { useSelfEmailsSetting } from '../profile/use-self-emails-setting.ts';
import { vaultOwnerKnown } from '../profile/vault-owner-known.ts';
import { NEEDS_OWNER_NOTICE, useMeetingCleanup } from './use-meeting-cleanup.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';

/**
 * The offered cleanup (#226) as app.tsx wires it: handed the owner only once
 * who they are has been read ({@link vaultOwnerKnown}). A settings note that
 * could not be read has answered but said nothing, so nothing is judged on
 * it; a vault that names nobody has nothing listed, and is told why; and a
 * task the person unticked before "Not now" is marked kept. All names are
 * made up. No node:sqlite: the index is faked.
 */

const VAULT = '/Users/mara/Vault';
const SETTINGS = '.atlas/settings.md';
const MEETING = 'Meetings/2026-10-14 Renewal review.md';
const MINE = 'Tasks/2026/10/Send the renewal contract.md';
const TOBIAS = 'Tasks/2026/10/Flag the new cache.md';

// A settings note the person (or a sync conflict) left with a YAML error: her name is in it, unreadable.
const BROKEN_SETTINGS = '---\nprofileName: Mara Quill\nselfEmails: [mara.quill@example.com\n---\n';
const OWNER_SETTINGS = '---\nprofileName: Mara Quill\nselfEmails: [mara.quill@example.com]\n---\n';
const NOBODY_SETTINGS = '---\ntheme: dark\n---\n';

const madeTask = (block: string) =>
  [
    '---',
    'type: task',
    'status: inbox',
    "meeting: '[[2026-10-14 Renewal review]]'",
    `atlas_item: item-${block}`,
    `source: '[[2026-10-14 Renewal review#^${block}]]'`,
    '---',
    '',
  ].join('\n');

const MEETING_FILE = [
  '---',
  'type: meeting',
  'atlas_import: meeting/v1',
  'title: Renewal review',
  "date: '2026-10-14'",
  'provider: gemini',
  'external_id: gemini-5c1d',
  'attendees:',
  '  - name: Mara Quill',
  '    email: mara.quill@example.com',
  '  - name: Tobias Fenn',
  '    email: tobias.fenn@example.com',
  '---',
  '',
  '## Transcript',
  '',
  '**Mara Quill** [~00:00:10] I’ll send the renewal contract by Friday. ^t0001',
  '',
  '**Tobias Fenn** [~00:00:20] I’ll flag the new cache. ^t0002',
  '',
].join('\n');

/** A vault in memory: the settings note given, the meeting, her own task and one Tobias spoke. */
function vaultWith(settings: string) {
  const files = new Map<string, string>([
    [SETTINGS, settings],
    [MEETING, MEETING_FILE],
    // Her own real commitment, which the rule rightly made.
    [MINE, madeTask('t0001')],
    [TOBIAS, madeTask('t0002')],
  ]);
  const fs = fakeVaultFs({
    listNotes: async () =>
      [...files.keys()]
        .filter((path) => !path.startsWith('.atlas/'))
        .map((path) => ({ name: path.split('/').at(-1)!, path, modified: 1, size: 1 }) as never),
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const text = files.get(path);
        return text === undefined ? [] : [{ path, text, modified: 1, size: 1 }];
      }),
    readTextFile: async (path) => ({ text: files.get(path) ?? '', modified: 1 }),
    writeTextFile: async ({ path, contents }) => {
      files.set(path, contents);
      return 2;
    },
  });
  const empty: QueryResult = { columns: [], rows: [], truncated: false };
  const index = {
    ...fakeIndexPort(),
    query: async (sql: string): Promise<QueryResult> =>
      sql.includes('meeting items: made')
        ? {
            columns: ['path', 'key', 'title'],
            rows: [
              [MINE, 'item-t0001', null],
              [TOBIAS, 'item-t0002', null],
            ],
            truncated: false,
          }
        : empty,
  };
  const editors = {
    state: () => 'closed' as const,
    flush: async () => {},
    follow: () => {},
    abandon: () => {},
    reload: () => {},
  };
  return { files, fs, index, editors };
}

function useAsAppWiresIt(vault: ReturnType<typeof vaultWith>) {
  const { fs, index, editors } = vault;
  const activity = recordingActivity();
  const profileSetting = useProfileSetting({
    fs,
    markdown: remarkMarkdown,
    vaultKey: VAULT,
    activity,
  });
  const selfEmailsSetting = useSelfEmailsSetting({
    fs,
    markdown: remarkMarkdown,
    index,
    vaultKey: VAULT,
    changeKey: '0',
    indexReady: true,
    activity,
  });
  // As app.tsx reads the owner.
  const ownerName = profileSetting.profile === 'unknown' ? null : profileSetting.profile.name;
  const ownerEmails = selfEmailsSetting.emails;
  const ownerKnown = vaultOwnerKnown(profileSetting, selfEmailsSetting);
  const cleanupOwner = useMemo(
    () => (ownerKnown ? { selfName: ownerName, selfEmails: ownerEmails } : null),
    [ownerKnown, ownerName, ownerEmails],
  );
  const ports = useMemo(
    () => ({ fs, markdown: remarkMarkdown, index, editors }) as never,
    [fs, index, editors],
  );
  const cleanup = useMeetingCleanup({
    ports,
    owner: cleanupOwner,
    vaultKey: VAULT,
    indexReady: true,
    open: true,
    activity,
    onChanged: () => {},
    onOpenTask: () => {},
  });
  return { profileSetting, ownerKnown, cleanup };
}

describe('the offered cleanup while the settings note cannot be read (#226)', () => {
  it('offers nothing for the Archive: who the owner is was never read, so nothing is judged', async () => {
    const hook = renderHook(() => useAsAppWiresIt(vaultWith(BROKEN_SETTINGS)), {
      wrapper: queryWrapper().wrapper,
    });
    // The settings note has answered, unreadably.
    await waitFor(() => expect(hook.result.current.profileSetting.settled).toBe(true));
    expect(hook.result.current.profileSetting.profile).toBe('unknown');
    expect(hook.result.current.ownerKnown).toBe(false);
    // Give the preview its chance to land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(hook.result.current.cleanup?.tasks ?? null).toBeNull();
  });
});

describe('the offered cleanup in a vault that names nobody (#226)', () => {
  it('lists nothing to tick, and says why', async () => {
    const vault = vaultWith(NOBODY_SETTINGS);
    const hook = renderHook(() => useAsAppWiresIt(vault), { wrapper: queryWrapper().wrapper });

    await waitFor(() => expect(hook.result.current.cleanup?.notice).toBe(NEEDS_OWNER_NOTICE));
    expect(hook.result.current.ownerKnown).toBe(true);
    expect(hook.result.current.cleanup?.tasks).toBeNull();
  });
});

describe('a task unticked before “Not now” (#226)', () => {
  it('is marked kept, so it is not listed again', async () => {
    const vault = vaultWith(OWNER_SETTINGS);
    const hook = renderHook(() => useAsAppWiresIt(vault), { wrapper: queryWrapper().wrapper });
    await waitFor(() =>
      expect(hook.result.current.cleanup?.tasks?.map(({ path }) => path)).toEqual([TOBIAS]),
    );

    act(() => hook.result.current.cleanup!.onToggle(TOBIAS));
    act(() => hook.result.current.cleanup!.onDismiss());

    await waitFor(() => expect(vault.files.get(TOBIAS)).toContain('atlas_item_kept: true'));
    expect(vault.files.get(MINE)).not.toContain('atlas_item_kept');
  });
});
