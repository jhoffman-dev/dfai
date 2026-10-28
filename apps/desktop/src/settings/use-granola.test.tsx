// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { createVaultPath } from '@dfai/domain';
import {
  fakeGranola,
  fakeVaultFs,
  GranolaError,
  type GranolaKeyStatus,
  type GranolaPort,
  type GranolaPullReport,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { GranolaPullController } from '../granola/use-granola-pull.ts';
import { GranolaSettingsCard } from './granola-settings-card.tsx';
import { useGranola, type GranolaSettingState } from './use-granola.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';

const VAULT = '/Users/mara/Vault';
const KEY = 'grn_fictional0123456789';
const ACCEPTED: GranolaKeyStatus = { hasKey: true, lastRefusal: null };
const REFUSED: GranolaKeyStatus = { hasKey: true, lastRefusal: 401 };

const PULLED: GranolaPullReport = {
  vault: VAULT,
  mode: 'sync-now',
  ended: 'pulled',
  written: [
    'Inbox/Meetings/2026-10-06 Larkspur Payroll renewal.md',
    'Inbox/Meetings/2026-10-06 Tobias one on one.md',
    'Inbox/Meetings/2026-10-07 Platform sync.md',
  ].map(createVaultPath),
  held: 12,
  refused: [
    {
      id: 'not_1',
      title: 'Untitled call',
      url: 'https://notes.granola.ai/d/not_1',
      problem: 'The meeting has no date',
    },
  ],
  skipped: [],
  failed: [],
  failure: null,
  problem: null,
  keyRefused: false,
  watermark: '2026-10-13T17:00:00.000Z',
};

const SETTINGS = '.atlas/settings.md';

/** A vault whose settings note is held in memory, written back as the host would. */
function vaultWith(settings = '---\nprofileName: Mara Quill\n---\n') {
  const file = { text: settings, modified: 1 };
  const fs = fakeVaultFs({
    readNotes: async (paths) =>
      paths.includes(SETTINGS)
        ? [{ path: SETTINGS, text: file.text, modified: file.modified, size: 1 }]
        : [],
    readTextFile: async () => ({ text: file.text, modified: file.modified }),
    writeTextFile: async ({ contents }) => {
      file.text = contents;
      file.modified += 1;
      return file.modified;
    },
  });
  return {
    file,
    ports: { fs, markdown: remarkMarkdown },
  };
}

const settingsOf = (vault = vaultWith()) => ({ ...vault.ports });

/** The window's puller as the card sees it, with a key held and nothing pulled. */
function pullWith(overrides: Partial<GranolaPullController> = {}): GranolaPullController {
  return {
    key: ACCEPTED,
    keyProblem: null,
    ready: true,
    pulling: false,
    report: null,
    lastPullAt: null,
    toast: null,
    toastShown: 0,
    dismissToast: () => {},
    syncNow: vi.fn(),
    syncNowFor: vi.fn(),
    knowKey: vi.fn(),
    ...overrides,
  };
}

function renderGranola({
  port = fakeGranola().port,
  pull = pullWith(),
  open = async () => {},
}: {
  port?: GranolaPort;
  pull?: GranolaPullController;
  open?: (url: string) => Promise<void>;
} = {}) {
  const settings = settingsOf();
  return renderHook(() => useGranola({ port, pull, vault: VAULT, links: { open }, ...settings }), {
    wrapper: queryWrapper().wrapper,
  });
}

describe('useGranola', () => {
  it('says whether a key is held, and Granola’s last word on it', () => {
    const view = (pull: GranolaPullController) => renderGranola({ pull }).result.current.view;
    expect(view(pullWith({ key: null })).keyState).toBe('checking');
    expect(view(pullWith({ key: { hasKey: false, lastRefusal: null } })).keyState).toBe('none');
    expect(view(pullWith({ key: ACCEPTED })).keyState).toBe('set');
    expect(view(pullWith({ key: REFUSED })).keyState).toBe('refused');
  });

  it('hands the key to the host, says Granola accepted it, and tells the puller', async () => {
    const granola = fakeGranola();
    const setKey = vi.spyOn(granola.port, 'setKey');
    const pull = pullWith();
    const hook = renderGranola({ port: granola.port, pull });

    act(() => hook.result.current.saveKey(KEY));

    await waitFor(() => expect(hook.result.current.view.keyState).toBe('accepted'));
    expect(setKey).toHaveBeenCalledWith({ vault: VAULT, key: KEY });
    expect(pull.knowKey).toHaveBeenCalledWith(ACCEPTED);
    expect(JSON.stringify(hook.result.current)).not.toContain(KEY);
  });

  it('says Granola refused a key it was just given', async () => {
    let known: GranolaKeyStatus = ACCEPTED;
    const port = { ...fakeGranola().port, setKey: async () => REFUSED };
    const settings = settingsOf();
    const hook = renderHook(
      () => {
        const pull = pullWith({ key: known, knowKey: (status) => (known = status) });
        return useGranola({
          port,
          pull,
          vault: VAULT,
          links: { open: async () => {} },
          ...settings,
        });
      },
      { wrapper: queryWrapper().wrapper },
    );
    act(() => hook.result.current.saveKey(KEY));
    await waitFor(() => expect(hook.result.current.view.pending).toBe(false));
    hook.rerender();
    expect(hook.result.current.view.keyState).toBe('refused');
  });

  it('takes one change of key at a time: a forget asked for while a save runs is refused', async () => {
    let answer: (status: GranolaKeyStatus) => void = () => {};
    const forgetKey = vi.fn(async () => ({ hasKey: false, lastRefusal: null }) as const);
    const port = {
      ...fakeGranola().port,
      setKey: () => new Promise<GranolaKeyStatus>((resolve) => (answer = resolve)),
      forgetKey,
    };
    const hook = renderGranola({ port });
    act(() => {
      hook.result.current.saveKey(KEY);
      hook.result.current.forgetKey();
    });
    expect(hook.result.current.view.pending).toBe(true);
    act(() => hook.result.current.forgetKey());
    expect(forgetKey).not.toHaveBeenCalled();

    await act(async () => answer(ACCEPTED));
    expect(hook.result.current.view.pending).toBe(false);
    act(() => hook.result.current.forgetKey());
    await waitFor(() => expect(forgetKey).toHaveBeenCalledOnce());
  });

  it('says why a key could not be kept', async () => {
    const port = {
      ...fakeGranola().port,
      setKey: async () => {
        throw new GranolaError({ kind: 'keychain', message: 'the Keychain is locked' });
      },
    };
    const hook = renderGranola({ port });
    act(() => hook.result.current.saveKey(KEY));
    await waitFor(() =>
      expect(hook.result.current.view.problem).toContain('The Keychain did not give DFAI'),
    );
    expect(hook.result.current.view.pending).toBe(false);
  });

  it('says what the last pull did, and lists the meetings it did not write', () => {
    const { view } = renderGranola({
      pull: pullWith({ report: PULLED, lastPullAt: Date.UTC(2026, 9, 13, 16, 40) }),
    }).result.current;
    expect(view.lastPull).toBe('3 new, 12 already in DFAI, 1 refused');
    expect(view.lastPullAt).not.toBeNull();
    expect(view.notes).toEqual([
      {
        id: 'not_1',
        title: 'Untitled call',
        url: 'https://notes.granola.ai/d/not_1',
        problem: 'The meeting has no date',
      },
    ]);
    expect(view.problem).toBeNull();
  });

  it('shows why the last pull stopped, on the card', () => {
    const problem = 'Granola refused the API key. Create one in Granola…';
    const { view } = renderGranola({
      pull: pullWith({ report: { ...PULLED, ended: 'stopped', written: [], problem } }),
    }).result.current;
    expect(view.problem).toBe(problem);
    expect(view.lastPull).toBeNull();
  });

  it('waits while the vault has not synced this session', () => {
    expect(renderGranola({ pull: pullWith({ ready: false }) }).result.current.view.waiting).toBe(
      true,
    );
  });

  it('says why a meeting could not be opened in Granola', async () => {
    const hook = renderGranola({
      open: async () => {
        throw new Error('only http and https links open');
      },
    });
    act(() => hook.result.current.openNote('https://notes.granola.ai/d/not_1'));
    await waitFor(() =>
      expect(hook.result.current.view.problem).toBe('only http and https links open'),
    );
  });
});

describe('GranolaSettingsCard', () => {
  it('keeps no key once it is saved: what the card is drawn from holds whether one is, never it', async () => {
    const granola = fakeGranola();
    const drawn: GranolaSettingState[] = [];
    const settings = settingsOf();
    function Harness() {
      const [key, setKey] = useState<GranolaKeyStatus | null>({ hasKey: false, lastRefusal: null });
      const setting = useGranola({
        port: granola.port,
        pull: pullWith({ key, knowKey: setKey }),
        vault: VAULT,
        links: { open: async () => {} },
        ...settings,
      });
      drawn.push(setting);
      return <GranolaSettingsCard setting={setting} />;
    }
    render(<Harness />, { wrapper: queryWrapper().wrapper });
    const card = screen.getByRole('region', { name: 'Granola' });

    await userEvent.type(within(card).getByLabelText('Granola API key'), KEY);
    await userEvent.click(within(card).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(within(card).getByTestId('granola-key').textContent).toBe('Key accepted'),
    );
    expect(within(card).getByLabelText<HTMLInputElement>('Granola API key').value).toBe('');
    expect(within(card).getByRole('button', { name: 'Sync now' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(drawn.length).toBeGreaterThan(1);
    for (const setting of drawn) expect(JSON.stringify(setting)).not.toContain(KEY);
  });
});

describe('useGranola: the settings it maps by', () => {
  const render = (vault = vaultWith()) => {
    const settings = settingsOf(vault);
    const port = fakeGranola().port;
    return renderHook(
      () =>
        useGranola({
          port,
          pull: pullWith(),
          vault: VAULT,
          links: { open: async () => {} },
          ...settings,
        }),
      { wrapper: queryWrapper().wrapper },
    );
  };

  it('says which addresses could not be read, the owner’s and the groups’, as a pull maps by none of them (#157)', async () => {
    const hook = render(
      vaultWith(
        '---\nselfEmails:\n  - not one\ngranola_group_addresses:\n  - eng@example..com\n---\n',
      ),
    );
    await waitFor(() =>
      expect(hook.result.current.view.addressesUnreadable).toBe(
        'Your emails in settings could not be read: Not an email address: “not one”. ' +
          'The group addresses in settings could not be read: Not an email address: “eng@example..com”.',
      ),
    );
  });

  it('says why the settings note could not be read', async () => {
    const vault = vaultWith();
    const refusing = {
      ...vault,
      ports: {
        ...vault.ports,
        fs: { ...vault.ports.fs, readNotes: () => Promise.reject(new Error('permission denied')) },
      },
    };
    const hook = render(refusing);
    await waitFor(() => expect(hook.result.current.view.problem).toBe('permission denied'));
    expect(hook.result.current.view.addressesUnreadable).toBeNull();
  });
});
