// #815: a notice clears itself while its details are read, so closing them
// finds no notice to give the focus back to. It goes to the notices' group,
// which is empty by then: it must show the focus, and move nothing to do so.
import { expect, test } from './fixtures.ts';
import { createVault, emitVaultChanged, installHost } from './host.ts';
import { expectFocusIn } from './typing.ts';

const SETTINGS = '.atlas/settings.md';
const UNREADABLE = '---\nsidebarOrder: [views\n  broken: : :\n---\n';
const READABLE = '---\nsidebarOrder: [types, views, dashboards, favorites, userSpace]\n---\n';

test('details closed by Esc after their notice cleared leave the focus on the notices, with a ring, and the window’s content where it was', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.mkdir('.atlas');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: /^Activity/ })
    .click();
  // By its class: under the open details the page is hidden from a role's reach, not from the eye.
  const content = page.locator('article.activity');
  await expect(content).toBeVisible();

  // Another program breaks the settings note: a red notice says so.
  await vault.write(SETTINGS, UNREADABLE);
  await emitVaultChanged(page, [SETTINGS]);
  const notices = page.getByRole('group', { name: 'Notices' });
  const notice = notices.locator('.notice').filter({ hasText: /settings\.md can.t be read/ });
  await expect(notice).toHaveCount(1);
  await notice.locator('.notice__details').click();
  const details = page.getByRole('dialog', { name: 'Error details' });
  await expect(details).toBeVisible();
  await expectFocusIn(details);

  // It mends the note while the details are read: the notice clears itself under them.
  await vault.write(SETTINGS, READABLE);
  await emitVaultChanged(page, [SETTINGS]);
  await expect(page.locator('.notices .notice')).toHaveCount(0);
  await expect(details).toBeVisible();
  const before = await content.boundingBox();

  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
  const group = page.locator('.notices');
  await expect(group).toBeFocused();
  // Closed by a key, so the focus shows; empty, the group has a box to show it on (WCAG 2.4.7).
  await expect
    .poll(() => group.evaluate((element) => element.matches(':focus-visible')))
    .toBe(true);
  await expect(group).toHaveCSS('box-shadow', /rgb/);
  const box = await group.boundingBox();
  expect(box?.width ?? 0, 'the focused notices are wide enough to see').toBeGreaterThanOrEqual(24);
  expect(box?.height ?? 0, 'the focused notices are tall enough to see').toBeGreaterThanOrEqual(2);
  // Shown over the window, not in it: nothing under the notices moved to make room.
  await expect.poll(() => content.boundingBox()).toEqual(before);
});
