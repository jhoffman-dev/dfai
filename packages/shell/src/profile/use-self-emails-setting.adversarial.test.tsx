// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeIndexPort, fakeVaultFs, recordingActivity, type QueryResult } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { ProfileSettingsCard } from './profile-settings-card.tsx';
import { useSelfEmailsSetting } from './use-self-emails-setting.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';

/** Adversarial (#173): Settings → Profile's emails when the vault refuses the write. */

const VAULT = '/Users/mara/Vault';
const SETTINGS = '.atlas/settings.md';
const noPeople = async (): Promise<QueryResult> => ({
  columns: ['path', 'title', 'type', 'key', 'value'],
  rows: [],
  truncated: false,
});

function refusingVault() {
  const file = { text: '---\nprofileName: Mara Quill\nselfEmails:\n  - mara@example.com\n---\n' };
  const fs = fakeVaultFs({
    readNotes: async (paths) =>
      paths.includes(SETTINGS) ? [{ path: SETTINGS, text: file.text, modified: 1, size: 1 }] : [],
    readTextFile: async () => ({ text: file.text, modified: 1 }),
    writeTextFile: async () => {
      throw new Error('The vault is read-only.');
    },
  });
  return { file, fs, index: { ...fakeIndexPort(), query: noPeople } };
}

function Card({ vault }: { vault: ReturnType<typeof refusingVault> }) {
  const emails = useSelfEmailsSetting({
    fs: vault.fs,
    markdown: remarkMarkdown,
    index: vault.index,
    vaultKey: VAULT,
    changeKey: '0',
    activity: recordingActivity(),
  });
  const profile = {
    profile: { name: 'Mara Quill', preferredName: '' },
    loaded: true,
    save: () => undefined,
    problem: null,
  };
  return <ProfileSettingsCard setting={profile as never} emails={emails} />;
}

describe('Settings → Profile → Your emails, when the write is refused', () => {
  it('keeps what was typed in the field, to try again, and says why it was not saved', async () => {
    const user = userEvent.setup();
    render(<Card vault={refusingVault()} />, { wrapper: queryWrapper().wrapper });
    const field = await screen.findByRole('textbox', { name: 'Your emails' });
    await waitFor(() => expect(field).toHaveProperty('value', 'mara@example.com'));

    await user.clear(field);
    await user.type(field, 'mq@example.org, mara.quill@example.com');
    // Leaving the field saves it (#226: no Save button).
    await user.tab();

    await waitFor(() =>
      expect(screen.getByRole('alert', { name: 'Your emails were not saved' }).textContent).toMatch(
        /^Couldn’t save: .*read-only/,
      ),
    );
    // The typed addresses are gone: the field went back to what the file holds.
    expect(field).toHaveProperty('value', 'mq@example.org, mara.quill@example.com');
  });
});
