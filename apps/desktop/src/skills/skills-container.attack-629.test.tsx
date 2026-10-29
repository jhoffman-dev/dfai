// @vitest-environment jsdom
/**
 * Attack on PR #629 (#169): "Used by" on the Skills page says which rules a
 * run would ask with each skill. A vault can hold two folders the same in
 * all but case (a sync, a copy from another Mac); a rule's run reads the one
 * its name matches exactly, so only that one is used by it.
 */
import { describe, expect, it } from 'vitest';
import { Profiler } from 'react';
import { act, render, screen } from '@testing-library/react';
import { createVaultPath, type VaultEntry } from '@dfai/domain';
import { fakeVaultFs, VaultAccessError } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { createOverlayStore } from '../overlay-store.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import {
  createAutomationsStore,
  publishAutomations,
  type AutomationsController,
  type AutomationsStore,
} from '../automations/automations-store.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import { SkillsContainer } from './skills-container.tsx';

const entry = (kind: VaultEntry['kind'], path: string, name: string) =>
  ({ kind, name, path: createVaultPath(path) }) as VaultEntry;

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

/** Two folders the same in all but case, each with a SKILL.md naming itself. */
function twinFolderVault() {
  const skillFor = (name: string) =>
    ['---', `name: ${name}`, 'description: Reviews.', '---', '', 'Step.', ''].join('\n');
  return fakeVaultFs({
    listDirectory: async (path) => {
      if (path === '.atlas/skills') {
        return [
          entry('directory', '.atlas/skills/Weekly-Review', 'Weekly-Review'),
          entry('directory', '.atlas/skills/weekly-review', 'weekly-review'),
        ];
      }
      for (const name of ['weekly-review', 'Weekly-Review']) {
        if (path === `.atlas/skills/${name}`) {
          return [entry('file', `.atlas/skills/${name}/SKILL.md`, 'SKILL.md')];
        }
      }
      throw new VaultAccessError('no such folder');
    },
    readTextFile: async (path) => ({
      text: skillFor(path.split('/')[2] ?? ''),
      modified: 1,
    }),
  });
}

describe('the automations that use a skill, attacked (#629 attack)', () => {
  it('names a rule as using only the folder its run would read, of two the same but for case', async () => {
    const store = createAutomationsStore();
    publishRules(store, [{ name: 'Weekly notes', skill: 'weekly-review' }]);
    showTab(twinFolderVault(), store);
    expect(await screen.findAllByText('Used by Weekly notes')).toHaveLength(1);
  });
});
