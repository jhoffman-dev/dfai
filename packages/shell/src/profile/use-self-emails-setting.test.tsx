// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { fakeIndexPort, fakeVaultFs, recordingActivity, type QueryResult } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useSelfEmailsSetting } from './use-self-emails-setting.ts';
import { readAgain, vaultReadKey } from '../reads/query-client.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';

/** #173: Settings → Profile keeps the owner's addresses as `selfEmails`, the one source. */

const VAULT = '/Users/mara/Vault';
const SETTINGS = '.atlas/settings.md';

/**
 * The index's answer to the link directory's query for one Person note,
 * Mara Quill's, with her two addresses. A fake rather than the SQLite test
 * index: this file runs in jsdom, where `node:sqlite` cannot be bundled.
 */
const MARA = 'People/Mara Quill.md';
const linkDirectory = async (): Promise<QueryResult> => ({
  columns: ['path', 'title', 'type', 'key', 'value'],
  rows: [
    [MARA, 'Mara Quill', 'person', 'email', 'mara.quill@example.com'],
    [MARA, 'Mara Quill', 'person', 'other_emails', 'mq@example.com'],
  ],
  truncated: false,
});

/** A vault whose settings note and Person note are held in memory, the settings written back as the host would. */
function vaultWith(settings: string | null = '---\nprofileName: Mara Quill\n---\n') {
  const file = { text: settings ?? '', modified: 1, unreadable: settings === null };
  const fs = fakeVaultFs({
    readNotes: async (paths) => {
      if (file.unreadable) throw new Error(`${SETTINGS} could not be read: permission denied`);
      return paths.includes(SETTINGS)
        ? [{ path: SETTINGS, text: file.text, modified: file.modified, size: 1 }]
        : [];
    },
    readTextFile: async () => ({ text: file.text, modified: file.modified }),
    writeTextFile: async ({ contents }) => {
      file.text = contents;
      file.modified += 1;
      return file.modified;
    },
  });
  return { file, fs, index: { ...fakeIndexPort(), query: linkDirectory } };
}

function render(vault = vaultWith()) {
  const { wrapper, client } = queryWrapper();
  const hook = renderHook(
    ({ changeKey }: { changeKey: string }) =>
      useSelfEmailsSetting({
        fs: vault.fs,
        markdown: remarkMarkdown,
        index: vault.index,
        vaultKey: VAULT,
        changeKey,
        activity: recordingActivity(),
      }),
    { wrapper, initialProps: { changeKey: '0' } },
  );
  /** The settings note changed: the window reads it again, as its reads say for its path. */
  const settingsChanged = () => act(() => readAgain(client, vaultReadKey(VAULT, 'settings')));
  return Object.assign(hook, { settingsChanged });
}

describe('useSelfEmailsSetting', () => {
  it('uses the Person note’s addresses while none are kept, with no save (#226), and a saved list over them', async () => {
    const vault = vaultWith();
    const hook = render(vault);
    await waitFor(() =>
      expect(hook.result.current.view.suggested).toBe('mara.quill@example.com, mq@example.com'),
    );
    expect(hook.result.current.view.kept).toBe('');
    expect(hook.result.current.emails).toEqual(['mara.quill@example.com', 'mq@example.com']);
    expect(hook.result.current.settled).toBe(true);
    expect(vault.file.text).not.toContain('selfEmails');

    act(() => void hook.result.current.save('Mara Quill <MQ@example.com>'));
    await waitFor(() => expect(vault.file.text).toContain('selfEmails:\n  - mq@example.com'));
    expect(vault.file.text).toContain('profileName: Mara Quill');
    await waitFor(() => expect(hook.result.current.view.kept).toBe('mq@example.com'));
    expect(hook.result.current.emails).toEqual(['mq@example.com']);
    expect(hook.result.current.view.suggested).toBeNull();
  });

  it('is unsettled while it holds no address until the Person note has been looked up', async () => {
    let answer: (result: QueryResult) => void = () => undefined;
    const vault = vaultWith();
    const hook = render({
      ...vault,
      index: { ...vault.index, query: () => new Promise<QueryResult>((done) => (answer = done)) },
    });
    await act(async () => undefined);
    expect(hook.result.current.settled).toBe(false);
    expect(hook.result.current.emails).toEqual([]);

    await act(async () => answer(await linkDirectory()));
    await waitFor(() => expect(hook.result.current.settled).toBe(true));
    expect(hook.result.current.emails).toEqual(['mara.quill@example.com', 'mq@example.com']);
  });

  it('settles with no address when the Person note cannot be looked up', async () => {
    const vault = vaultWith();
    const hook = render({
      ...vault,
      index: { ...vault.index, query: () => Promise.reject(new Error('index closed')) },
    });
    await waitFor(() => expect(hook.result.current.settled).toBe(true));
    expect(hook.result.current.emails).toEqual([]);
  });

  it('uses the Granola key’s addresses while selfEmails keeps none, and says where they come from', async () => {
    const vault = vaultWith('---\ngranola_self_emails:\n  - mara@example.com\n---\n');
    const hook = render(vault);
    await waitFor(() => expect(hook.result.current.emails).toEqual(['mara@example.com']));
    expect(hook.result.current.view).toMatchObject({ kept: '', inherited: 'mara@example.com' });

    act(() => void hook.result.current.save('mara@example.com'));
    // Moved in one write: selfEmails holds the addresses, and the Granola key is gone.
    await waitFor(() =>
      expect(vault.file.text).toBe('---\nselfEmails:\n  - mara@example.com\n---\n'),
    );
    await waitFor(() => expect(hook.result.current.view.kept).toBe('mara@example.com'));
    expect(hook.result.current.view.inherited).toBeNull();
  });

  it('removes the Granola key too when the field is cleared while only it holds addresses', async () => {
    const vault = vaultWith(
      '---\nprofileName: Mara Quill\ngranola_self_emails:\n  - mara@example.com\n---\n',
    );
    const hook = render(vault);
    await waitFor(() => expect(hook.result.current.view.inherited).toBe('mara@example.com'));

    let kept = false;
    await act(async () => {
      kept = await hook.result.current.save('');
    });
    expect(kept).toBe(true);
    expect(vault.file.text).toBe('---\nprofileName: Mara Quill\n---\n');
    await waitFor(() => expect(hook.result.current.view.inherited).toBeNull());
    // With nothing saved, the Person note's addresses are the owner's again (#226).
    await waitFor(() =>
      expect(hook.result.current.emails).toEqual(['mara.quill@example.com', 'mq@example.com']),
    );
  });

  it('is unsettled until the settings note answers, and hands out one empty list meanwhile', async () => {
    const vault = vaultWith('---\nprofileName: Mara Quill\n---\n');
    const hook = render(vault);
    const before = hook.result.current.emails;
    expect(hook.result.current.settled).toBe(false);
    // The same empty list each render: what is memoised on it is not made again for nothing.
    hook.rerender({ changeKey: '0' });
    expect(hook.result.current.settled).toBe(false);
    expect(hook.result.current.emails).toBe(before);
    await waitFor(() => expect(hook.result.current.settled).toBe(true));
  });

  it('is settled, with no address, once the settings note is found unreadable', async () => {
    const hook = render(vaultWith(null));
    await waitFor(() => expect(hook.result.current.settled).toBe(true));
    expect(hook.result.current.emails).toEqual([]);
  });

  it('removes selfEmails when every address is taken out', async () => {
    const vault = vaultWith('---\nselfEmails:\n  - mara@example.com\n---\n');
    const hook = render(vault);
    await waitFor(() => expect(hook.result.current.view.kept).toBe('mara@example.com'));
    act(() => void hook.result.current.save('  '));
    await waitFor(() => expect(vault.file.text).not.toContain('selfEmails'));
    expect(hook.result.current.emails).toEqual([]);
  });

  it('refuses, and keeps nothing of, addresses typed with words that are not addresses', async () => {
    const vault = vaultWith('---\nselfEmails:\n  - mara@example.com\n---\n');
    const hook = render(vault);
    await waitFor(() => expect(hook.result.current.view.kept).toBe('mara@example.com'));
    const before = vault.file.text;
    let kept = true;
    await act(async () => {
      kept = await hook.result.current.save('mq@example.com, Mara Quill');
    });
    expect(kept).toBe(false);
    expect(hook.result.current.view.problem).toBe(
      'Not an email address: “Mara”, “Quill”. Nothing was saved.',
    );
    await act(async () => undefined);
    expect(vault.file.text).toBe(before);
    expect(hook.result.current.emails).toEqual(['mara@example.com']);

    await act(async () => {
      kept = await hook.result.current.save('Mara Quill <MQ@example.com>');
    });
    expect(kept).toBe(true);
    expect(hook.result.current.view.problem).toBeNull();
    expect(vault.file.text).toContain('selfEmails:\n  - mq@example.com');
  });

  it('reads addresses the settings hold that are not all addresses as none, and says why', async () => {
    const vault = vaultWith(
      '---\nprofileName: Mara Quill\nselfEmails: mara.quill@example.com, Mara\ngranola_self_emails:\n  - mara.quill@example.com\n---\n',
    );
    const hook = render(vault);
    await waitFor(() =>
      expect(hook.result.current.view.unreadable).toBe(
        'Your emails in settings could not be read: Not an email address: “Mara”.',
      ),
    );
    // Nothing guessed: not the readable part, and not the Granola key's.
    expect(hook.result.current.emails).toEqual([]);
    expect(hook.result.current.view).toMatchObject({ kept: '', inherited: null });

    act(() => void hook.result.current.save('mara.quill@example.com'));
    // Saved over what could not be read: the card stops saying so at once, not once it is read again.
    expect(hook.result.current.view.unreadable).toBeNull();
    await waitFor(() =>
      expect(vault.file.text).toContain('selfEmails:\n  - mara.quill@example.com'),
    );
    expect(hook.result.current.view.kept).toBe('mara.quill@example.com');
  });

  it('uses no address, and cannot be changed, while the settings note cannot be read', async () => {
    const hook = render(vaultWith(null));
    await waitFor(() =>
      expect(hook.result.current.problem).toBe(`${SETTINGS} could not be read: permission denied`),
    );
    expect(hook.result.current.emails).toEqual([]);
    expect(hook.result.current.view.disabled).toBe(true);
  });

  it('stops using the addresses it read once the settings note can no longer be read', async () => {
    const vault = vaultWith('---\nselfEmails:\n  - mara@example.com\n---\n');
    const hook = render(vault);
    await waitFor(() => expect(hook.result.current.emails).toEqual(['mara@example.com']));

    vault.file.unreadable = true;
    await hook.settingsChanged();

    await waitFor(() => expect(hook.result.current.problem).toContain('could not be read'));
    expect(hook.result.current.emails).toEqual([]);
    expect(hook.result.current.view.disabled).toBe(true);
  });

  /*
   * #231: every vault change reads the addresses again. Handed out as a new
   * array each time, the owner looked changed to everything keyed on it —
   * the meeting cleanup's preview, the meeting import, the Claude step — and
   * each filing set all of it off again, so Inbox filings fell tens of
   * seconds behind the page.
   */
  it('hands out the same addresses, unchanged, after a vault change that leaves the Person note’s as they were', async () => {
    const vault = vaultWith();
    let lookups = 0;
    const hook = render({
      ...vault,
      index: { ...vault.index, query: (...asked) => ((lookups += 1), linkDirectory(...asked)) },
    });
    await waitFor(() =>
      expect(hook.result.current.emails).toEqual(['mara.quill@example.com', 'mq@example.com']),
    );
    const first = hook.result.current.emails;
    const before = lookups;

    hook.rerender({ changeKey: '1' });
    await waitFor(() => expect(lookups).toBeGreaterThan(before));
    await act(async () => undefined);

    expect(hook.result.current.emails).toBe(first);
  });

  it('hands out the same addresses, unchanged, after the settings note is read again and keeps them as they were', async () => {
    const vault = vaultWith('---\nselfEmails:\n  - mara@example.com\n---\n');
    let reads = 0;
    const readNotes = vault.fs.readNotes;
    const hook = render({
      ...vault,
      fs: { ...vault.fs, readNotes: (paths) => ((reads += 1), readNotes(paths)) },
    });
    await waitFor(() => expect(hook.result.current.emails).toEqual(['mara@example.com']));
    const first = hook.result.current.emails;
    const before = reads;

    await hook.settingsChanged();
    await waitFor(() => expect(reads).toBeGreaterThan(before));
    await act(async () => undefined);

    expect(hook.result.current.emails).toBe(first);
  });

  it('hands out the new addresses once they change', async () => {
    const vault = vaultWith('---\nselfEmails:\n  - mara@example.com\n---\n');
    const hook = render(vault);
    await waitFor(() => expect(hook.result.current.emails).toEqual(['mara@example.com']));

    vault.file.text = '---\nselfEmails:\n  - mara@example.com\n  - mq@example.com\n---\n';
    await hook.settingsChanged();

    await waitFor(() =>
      expect(hook.result.current.emails).toEqual(['mara@example.com', 'mq@example.com']),
    );
  });
});
