// @vitest-environment jsdom
/*
 * Attack on PR #699 (#657): the web build, mounted as main.ts mounts it, on a
 * vault holding a rule with a Claude step. `it.fails` marks what the PR still
 * lets through; the plain `it`s are probes it holds.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { NEEDS_THE_DESKTOP_APP } from '@dfai/application';
import { createVaultPath } from '@dfai/domain';
import { mountShell, type AppPorts } from '@dfai/shell';
import { composeWebShell } from './composition.ts';
import { SAMPLE_NOTES } from './sample-vault.ts';
import { sessionVaultFs } from './session-vault.ts';

beforeAll(() => vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel'));

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  document.body.innerHTML = '';
  window.localStorage.clear();
});

/** Frontmatter written as JSON values, which YAML reads as they are. */
const frontmatter = (props: Record<string, unknown>) =>
  `---\n${Object.entries(props)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n')}\n---\n`;

const RULES = '.atlas/automations';
const RULE_PATH = createVaultPath(`${RULES}/Ask weekly.md`);

/** A rule a desktop wrote and sync brought in: it asks Claude. */
const CLAUDE_RULE = frontmatter({
  atlas: 'automation',
  id: 'Ask weekly',
  name: 'Ask weekly',
  enabled: true,
  when: 'on app open',
  which: 'type = task',
  olderThanDays: null,
  do: 'claude',
  prompt: 'Summarise the week',
  output: 'proposals',
  tools: [],
});

/** The presets that ask Claude, as the Automations page lists them. */
const CLAUDE_PRESETS = [
  'Pull actions and decisions out of a new meeting',
  'After a meeting',
  'Friday review',
  'Morning brief',
];

/** The web build on the sample vault plus `extra`, and the vault's files to read back. */
async function openedWith(extra: Record<string, string>) {
  const shell = composeWebShell();
  const fs = sessionVaultFs({ ...SAMPLE_NOTES, ...extra });
  const ports: AppPorts = {
    ...shell.ports,
    vault: { ...shell.ports.vault, fs },
    notes: { ...shell.ports.notes, fs },
    index: { ...shell.ports.index, fs },
  };
  document.body.innerHTML = '<div id="root"></div>';
  unmount = mountShell({ ...shell, ports });
  await screen.findByRole('treeitem', { name: 'Welcome' }, { timeout: 10_000 });
  return fs;
}

/** The Automations page, drawn with its list read. */
async function automationsPage() {
  fireEvent.click(screen.getByRole('button', { name: 'Automations' }));
  const page = await screen.findByRole('article', { name: 'Automations' }, { timeout: 10_000 });
  // The one preset with no Claude step is drawn (in the page bar, outside the article): the adders have drawn.
  await screen.findByRole(
    'button',
    { name: 'Archive done tasks after 30 days' },
    { timeout: 10_000 },
  );
  return page;
}

/** Lets the runner's ticks and writes settle. */
const settled = () => act(() => new Promise((resolve) => setTimeout(resolve, 500)));

describe('the web build and rules with a Claude step (#699 attack)', () => {
  it(
    'holds a synced-in Claude rule, saying it needs the desktop app, and leaves its file byte for byte',
    { timeout: 30_000 },
    async () => {
      const fs = await openedWith({ [RULE_PATH]: CLAUDE_RULE });
      const page = await automationsPage();
      await within(page).findByText(NEEDS_THE_DESKTOP_APP, {}, { timeout: 10_000 });
      fireEvent.click(within(page).getByRole('button', { name: 'Run Ask weekly now' }));
      await settled();
      expect((await fs.readTextFile(RULE_PATH)).text).toBe(CLAUDE_RULE);
    },
  );

  it(
    'keeps the Claude step when the rule is saved from the editor on the web',
    { timeout: 30_000 },
    async () => {
      const fs = await openedWith({ [RULE_PATH]: CLAUDE_RULE });
      const page = await automationsPage();
      fireEvent.click(within(page).getAllByText('Ask weekly')[0]!);
      const save = await screen.findByRole('button', { name: 'Save' }, { timeout: 10_000 });
      // A real change, so the save writes: run by hand instead of on opening.
      fireEvent.click(screen.getByRole('radio', { name: 'By hand' }));
      fireEvent.click(save);
      await settled();
      const text = (await fs.readTextFile(RULE_PATH)).text;
      expect(text).not.toBe(CLAUDE_RULE);
      expect(text).toMatch(/^do: "?claude"?$/m);
      expect(text).toContain('Summarise the week');
    },
  );

  it.fails(
    'offers no preset that asks Claude where no Claude Code runs',
    { timeout: 30_000 },
    async () => {
      await openedWith({});
      const page = await automationsPage();
      void page;
      const drawn = screen.getAllByRole('button').map((button) => button.textContent);
      for (const name of CLAUDE_PRESETS) expect(drawn).not.toContain(name);
    },
  );

  it.fails('writes no Claude-step rule on the web from a preset', { timeout: 30_000 }, async () => {
    const fs = await openedWith({});
    const page = await automationsPage();
    void page;
    const preset = screen.queryByRole('button', { name: 'Morning brief' });
    if (preset !== null) {
      fireEvent.click(preset);
      fireEvent.click(
        await screen.findByRole('button', { name: 'Create automation' }, { timeout: 10_000 }),
      );
      await settled();
    }
    const rules = await fs.listDirectory(createVaultPath(RULES)).catch(() => []);
    const texts = await Promise.all(
      rules
        .filter((entry) => entry.kind === 'file')
        .map(async (entry) => (await fs.readTextFile(createVaultPath(entry.path))).text),
    );
    expect(texts.filter((text) => /^do: "?claude"?$/m.test(text))).toEqual([]);
  });
});
