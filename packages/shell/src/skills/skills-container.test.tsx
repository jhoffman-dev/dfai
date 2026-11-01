// @vitest-environment jsdom
/**
 * The Skills page as a tab (#169, #626 review): the question before a delete
 * is one of the window's overlays, and a tab closed — with the question up,
 * or while the folder is still being walked before it — leaves no overlay
 * up to hold the screen with nothing drawn.
 */
import { describe, expect, it } from 'vitest';
import { Profiler } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, type VaultEntry } from '@dfai/domain';
import { fakeVaultFs, VaultAccessError } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { createOverlayStore, overlayNow } from '../overlay-store.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import {
  createAutomationsStore,
  publishAutomations,
  type AutomationsController,
  type AutomationsStore,
} from '../automations/automations-store.ts';
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

function showTab(
  fs: ReturnType<typeof fakeVaultFs>,
  store: AutomationsStore = createAutomationsStore(),
) {
  const overlays = createOverlayStore();
  const wiring = {
    pages: {
      ports: { fs },
      openNote: () => {},
      automations: { store },
      skills: { claude: {}, offersAsk: true },
    },
    pane: { vault: '/vaults/larkspur', notes: { markdown: remarkMarkdown } },
    overlays,
  } as unknown as PageContainerProps['wiring'];
  let draws = 0;
  const view = render(
    <Profiler id="skills" onRender={() => (draws += 1)}>
      <SkillsContainer wiring={wiring} tabId={'tab-1' as PageContainerProps['tabId']} chrome={{}} />
    </Profiler>,
    { wrapper: queryWrapper().wrapper },
  );
  return { ...view, overlays, draws: () => draws };
}

/** The runner saying where the rules stand: a new listing each time, as each minute's read is. */
function publishRules(
  store: AutomationsStore,
  rules: { name: string; skill: string }[],
  broken: { name: string; skill?: string }[] = [],
) {
  const listing = {
    automations: rules.map(({ name, skill }) => ({
      rule: { name, action: { kind: 'claude', skill } },
    })),
    broken: broken.map(({ name, skill }) => ({
      name,
      path: `.atlas/automations/${name}.md`,
      problem: 'It cannot be read.',
      ...(skill !== undefined && { skill }),
    })),
  };
  act(() => publishAutomations(store, { listing } as unknown as AutomationsController));
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

  describe('the automations that use a skill (#629 review)', () => {
    it('draws nothing more when the runner reads the same rules again', async () => {
      const { fs, letWalkGo } = oneSkillVault();
      letWalkGo();
      const store = createAutomationsStore();
      publishRules(store, [{ name: 'Weekly notes', skill: 'weekly-review' }]);
      const tab = showTab(fs, store);
      expect(await screen.findByText('Used by Weekly notes')).toBeTruthy();
      const before = tab.draws();

      // The minute's read, and a run's: new objects, the same rules.
      publishRules(store, [{ name: 'Weekly notes', skill: 'weekly-review' }]);
      publishRules(store, [{ name: 'Weekly notes', skill: 'weekly-review' }]);

      expect(tab.draws()).toBe(before);
      // A change in which rules use it is drawn.
      publishRules(store, [
        { name: 'Weekly notes', skill: 'weekly-review' },
        { name: 'After standup', skill: 'weekly-review' },
      ]);
      expect(await screen.findByText('Used by After standup, Weekly notes')).toBeTruthy();
      expect(tab.draws()).toBeGreaterThan(before);
    });

    it('counts a broken rule that names the skill', async () => {
      const { fs, letWalkGo } = oneSkillVault();
      letWalkGo();
      const store = createAutomationsStore();
      publishRules(
        store,
        [],
        [{ name: 'Typo in tools', skill: 'weekly-review' }, { name: 'Other' }],
      );
      showTab(fs, store);
      expect(await screen.findByText('Used by Typo in tools')).toBeTruthy();
    });
  });
});
