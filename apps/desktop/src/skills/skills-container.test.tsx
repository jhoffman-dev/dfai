// @vitest-environment jsdom
/**
 * The Skills page as a tab (#169, #626 review): the question before a delete
 * is one of the window's overlays, and a tab closed — with the question up,
 * or while the folder is still being walked before it — leaves no overlay
 * up to hold the screen with nothing drawn.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, type VaultEntry } from '@dfai/domain';
import { fakeVaultFs, VaultAccessError } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { createOverlayStore, overlayNow } from '../overlay-store.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import { SkillsContainer } from './skills-container.tsx';

const SKILL = ['---', 'name: weekly-review', 'description: Reviews.', '---', '', 'Step.', ''].join(
  '\n',
);

const entry = (kind: VaultEntry['kind'], path: string, name: string) =>
  ({ kind, name, path: createVaultPath(path) }) as VaultEntry;

/** One skill, and a walk of its folder that waits until `letWalkGo` is called. */
function oneSkillVault() {
  let letWalkGo = () => {};
  const walked = new Promise<void>((done) => {
    letWalkGo = done;
  });
  const fs = fakeVaultFs({
    listDirectory: async (path) => {
      if (path === '.atlas/skills') {
        return [entry('directory', '.atlas/skills/weekly-review', 'weekly-review')];
      }
      if (path === '.atlas/skills/weekly-review') {
        await walked;
        return [entry('file', '.atlas/skills/weekly-review/SKILL.md', 'SKILL.md')];
      }
      throw new VaultAccessError('no such folder');
    },
    readTextFile: async () => ({ text: SKILL, modified: 1 }),
  });
  return { fs, letWalkGo };
}

function showTab(fs: ReturnType<typeof fakeVaultFs>) {
  const overlays = createOverlayStore();
  const wiring = {
    pages: { ports: { fs }, openNote: () => {} },
    pane: { vault: '/vaults/larkspur', notes: { markdown: remarkMarkdown } },
    overlays,
  } as unknown as PageContainerProps['wiring'];
  const view = render(
    <SkillsContainer wiring={wiring} tabId={'tab-1' as PageContainerProps['tabId']} chrome={{}} />,
    { wrapper: queryWrapper().wrapper },
  );
  return { ...view, overlays };
}

async function askToDelete() {
  await userEvent.click(await screen.findByRole('button', { name: /^weekly-review/ }));
  const editor = await screen.findByRole('form', { name: 'Skill weekly-review' });
  await userEvent.click(within(editor).getByRole('button', { name: 'Delete…' }));
}

describe('SkillsContainer', () => {
  it('draws the question while the window holds it, and closing the tab takes it down', async () => {
    const { fs, letWalkGo } = oneSkillVault();
    letWalkGo();
    const { overlays, unmount } = showTab(fs);
    await askToDelete();
    expect(await screen.findByRole('alertdialog', { name: 'Delete this skill?' })).toBeTruthy();
    expect(overlayNow(overlays)).toBe('skill-delete');
    unmount();
    expect(overlayNow(overlays)).toBeNull();
  });

  it('puts up no question for a tab closed while the folder was still being walked', async () => {
    const { fs, letWalkGo } = oneSkillVault();
    const { overlays, unmount } = showTab(fs);
    await askToDelete();
    unmount();
    letWalkGo();
    // The walk's answer arrives after the tab has gone.
    await new Promise((settled) => setTimeout(settled, 0));
    expect(overlayNow(overlays)).toBeNull();
  });
});
