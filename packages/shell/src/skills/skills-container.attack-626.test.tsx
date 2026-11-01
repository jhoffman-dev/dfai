// @vitest-environment jsdom
/**
 * Attack on PR #626 (#169), the Skills tab as drawn: where the focus goes
 * when the editor closes, and what opening the tab asks of the host.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, type VaultEntry } from '@dfai/domain';
import { fakeVaultFs, VaultAccessError } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { createOverlayStore } from '../overlay-store.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { createAutomationsStore } from '../automations/automations-store.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import { SkillsContainer } from './skills-container.tsx';

const SKILL = ['---', 'name: weekly-review', 'description: Reviews.', '---', '', 'Step.', ''].join(
  '\n',
);

const entry = (kind: VaultEntry['kind'], path: string, name: string) =>
  ({ kind, name, path: createVaultPath(path) }) as VaultEntry;

/** One skill and one prompt note; every host call is written down as `command path`. */
function countedVault() {
  const calls: string[] = [];
  const listings: Record<string, VaultEntry[]> = {
    '.atlas/skills': [entry('directory', '.atlas/skills/weekly-review', 'weekly-review')],
    '.atlas/skills/weekly-review': [
      entry('file', '.atlas/skills/weekly-review/SKILL.md', 'SKILL.md'),
    ],
    '.atlas/prompts': [entry('file', '.atlas/prompts/morning-brief.md', 'morning-brief.md')],
  };
  const fs = fakeVaultFs({
    listDirectory: async (path) => {
      calls.push(`listDirectory ${path}`);
      const found = listings[path];
      if (found === undefined) throw new VaultAccessError('no such folder');
      return found;
    },
    readTextFile: async (path) => {
      calls.push(`readTextFile ${path}`);
      return { text: SKILL, modified: 1 };
    },
  });
  return { fs, calls };
}

function showTab(fs: ReturnType<typeof fakeVaultFs>) {
  const wiring = {
    pages: {
      ports: { fs },
      openNote: () => {},
      automations: { store: createAutomationsStore() },
      skills: { claude: {}, offersAsk: true },
    },
    pane: { vault: '/vaults/larkspur', notes: { markdown: remarkMarkdown } },
    overlays: createOverlayStore(),
  } as unknown as PageContainerProps['wiring'];
  return render(
    <SkillsContainer wiring={wiring} tabId={'tab-1' as PageContainerProps['tabId']} chrome={{}} />,
    { wrapper: queryWrapper().wrapper },
  );
}

async function openWeekly() {
  await userEvent.click(await screen.findByRole('button', { name: /^weekly-review/ }));
  return screen.findByRole('form', { name: 'Skill weekly-review' });
}

describe('SkillsContainer, attacked (#626)', () => {
  it('keeps the focus off the page body when the editor is closed with Close', async () => {
    const { fs } = countedVault();
    showTab(fs);
    const editor = await openWeekly();
    const close = within(editor).getByRole('button', { name: 'Close' });
    close.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
  });

  it('keeps the focus off the page body when a new skill is cancelled', async () => {
    const { fs } = countedVault();
    showTab(fs);
    await screen.findByRole('button', { name: /^weekly-review/ });
    await userEvent.click(screen.getByRole('button', { name: 'New skill' }));
    const editor = await screen.findByRole('form', { name: 'New skill' });
    within(editor).getByRole('button', { name: 'Cancel' }).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
  });

  it('reads only .atlas/skills and .atlas/prompts when the tab opens', async () => {
    const { fs, calls } = countedVault();
    showTab(fs);
    await screen.findByRole('button', { name: /^weekly-review/ });
    await screen.findByRole('button', { name: 'Open morning-brief prompt' });
    expect([...calls].sort()).toEqual([
      'listDirectory .atlas/prompts',
      'listDirectory .atlas/skills',
      'readTextFile .atlas/skills/weekly-review/SKILL.md',
    ]);
  });

  it('asks the host nothing until a vault is open', async () => {
    const { fs, calls } = countedVault();
    const wiring = {
      pages: {
        ports: { fs },
        openNote: () => {},
        automations: { store: createAutomationsStore() },
        skills: { claude: {}, offersAsk: true },
      },
      pane: { vault: null, notes: { markdown: remarkMarkdown } },
      overlays: createOverlayStore(),
    } as unknown as PageContainerProps['wiring'];
    render(
      <SkillsContainer
        wiring={wiring}
        tabId={'tab-1' as PageContainerProps['tabId']}
        chrome={{}}
      />,
      { wrapper: queryWrapper().wrapper },
    );
    await screen.findByRole('heading', { name: 'All skills' });
    expect(calls).toEqual([]);
  });
});
