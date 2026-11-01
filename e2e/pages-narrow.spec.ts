import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost } from './host.ts';

/**
 * UI v2 slice 13b, review of #393: a fixed page in a narrow pane. A rule's
 * 34px row keeps its name to its own column, cut short, so the name is still
 * the thing under the pointer; and an Activity line's "Open …" button is
 * capped, so a long subject never pushes the row past the pane.
 */

const LONG_NAME = 'Archive every task that has been done for thirty days or more now';
const LONG_TITLE = 'A project whose name goes on for longer than any row would like';

const rule = (name: string) =>
  `---\natlas: automation\nname: ${name}\nenabled: true\nwhen: manually\nwhich: FROM task WHERE status = done\ndo: archive\nid: ${name}\n---\n`;

async function openNarrow(page: Page, seed: (root: string, line: string) => void) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/automations');
  await vault.mkdir('Projects');
  await vault.write(
    '.atlas/types/task.md',
    '---\nname: task\nproperties:\n  status:\n    kind: select\n    options: [doing, done]\n---\n',
  );
  await vault.write(`.atlas/automations/${LONG_NAME}.md`, rule(LONG_NAME));
  await vault.write(`Projects/${LONG_TITLE}.md`, `# ${LONG_TITLE}\n`);
  const host = await installHost(page, vault);
  const line = JSON.stringify({
    at: Date.now() - 3_600_000,
    level: 'info',
    kind: 'chat',
    message: 'Edited it, as Claude proposed.',
    subject: { kind: 'note', path: `Projects/${LONG_TITLE}.md` },
  });
  seed(vault.root, `${line}\n`);
  host.seedActivity(vault.root, `${line}\n`);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
}

/** Squeezes the window once the page is open: under 944px the sidebar is a drawer (#658). */
const squeeze = (page: Page) => page.setViewportSize({ width: 720, height: 600 });

test('a long rule name is cut short in its own column, so its centre still opens the rule', async ({
  page,
}) => {
  await openNarrow(page, () => undefined);
  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: 'Automations', exact: true })
    .click();
  await squeeze(page);
  const list = page.getByRole('list', { name: 'All automations' });
  const name = list.getByRole('button', { name: LONG_NAME, exact: true });
  await expect(name).toBeVisible();
  const row = list.getByRole('listitem').first();
  // The name stays inside its row: nothing of it runs under the times or Run now.
  const [nameBox, runBox] = await Promise.all([
    name.boundingBox(),
    row.getByRole('button', { name: `Run ${LONG_NAME} now` }).boundingBox(),
  ]);
  expect(nameBox!.x + nameBox!.width).toBeLessThan(runBox!.x);
  await expect(name).toHaveAttribute('title', LONG_NAME);
  // Playwright clicks the centre, and refuses when another element would take the pointer.
  await name.click({ timeout: 3_000 });
  await expect(name).toHaveAttribute('aria-current', 'true');
});

test('a long "Open …" subject is capped, so an Activity line never runs past the pane', async ({
  page,
}) => {
  await openNarrow(page, () => undefined);
  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: /^Activity/ })
    .click();
  await squeeze(page);
  const lines = page.getByRole('list', { name: 'Activity lines' });
  const open = lines.getByRole('button', { name: `Open ${LONG_TITLE}` });
  await expect(open).toBeVisible();
  await expect
    .poll(() => lines.evaluate((list) => list.scrollWidth - list.clientWidth))
    .toBeLessThanOrEqual(0);
  await expect(open).toHaveAttribute('title', `Open ${LONG_TITLE}`);
});
