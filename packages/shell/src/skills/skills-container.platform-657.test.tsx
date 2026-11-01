// @vitest-environment jsdom
/**
 * Skills' "Ask Claude…" where the platform has no Claude Code (#657): the
 * editor is drawn as ever, without the ask.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

const LISTINGS: Record<string, VaultEntry[]> = {
  '.atlas/skills': [entry('directory', '.atlas/skills/weekly-review', 'weekly-review')],
  '.atlas/skills/weekly-review': [
    entry('file', '.atlas/skills/weekly-review/SKILL.md', 'SKILL.md'),
  ],
};

/** The Skills tab with one skill, opened in the editor. */
async function editorWith(offersAsk: boolean) {
  const fs = fakeVaultFs({
    listDirectory: async (path) => {
      const found = LISTINGS[path];
      if (found === undefined) throw new VaultAccessError('no such folder');
      return found;
    },
    readTextFile: async () => ({ text: SKILL, modified: 1 }),
  });
  const wiring = {
    pages: {
      ports: { fs },
      openNote: () => {},
      automations: { store: createAutomationsStore() },
      skills: { claude: {}, offersAsk },
    },
    pane: { vault: '/vaults/larkspur', notes: { markdown: remarkMarkdown } },
    overlays: createOverlayStore(),
  } as unknown as PageContainerProps['wiring'];
  render(
    <SkillsContainer wiring={wiring} tabId={'tab-1' as PageContainerProps['tabId']} chrome={{}} />,
    { wrapper: queryWrapper().wrapper },
  );
  await userEvent.click(await screen.findByRole('button', { name: /^weekly-review/ }));
  return screen.findByRole('form', { name: 'Skill weekly-review' });
}

describe('SkillsContainer, by platform (#657)', () => {
  it('offers Ask Claude where Claude Code runs', async () => {
    const editor = await editorWith(true);
    expect(within(editor).getByRole('button', { name: 'Ask Claude…' })).toBeDefined();
  });

  it('offers no Ask Claude where it does not, and still edits the skill', async () => {
    const editor = await editorWith(false);
    expect(within(editor).getByRole('button', { name: 'Close' })).toBeDefined();
    expect(within(editor).queryByRole('button', { name: 'Ask Claude…' })).toBeNull();
  });
});
