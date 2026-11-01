import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeVault } from './host.ts';
import { pickSuggestion } from './link-suggest.ts';

/**
 * Adversarial pass on #112: the Inbox row worked the way a person changes
 * their mind on it, and rows whose titles are not polite.
 */

const GTD_TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '  waiting_on:',
  '    kind: relation',
  '    target: person',
  '  defer: date',
  '  due: date',
  '  completed: date',
  '---',
  '',
  '# Task',
  '',
].join('\n');

const PERSON_TYPE = ['---', 'name: person', 'label: Person', '---', '', '# Person', ''].join('\n');
const TASK = '---\ntype: task\nstatus: inbox\n---\n\nAbout the lease.\n';

const MARKUP = '<img src=x onerror=alert(1)><b>bold<b> ]] [[Mara Quill]] 📞 שלום';
const LONG = `Unbroken${'x'.repeat(200)}`;

async function vaultWith(titles: readonly string[]): Promise<FakeVault> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'People', 'Inbox']) await vault.mkdir(folder);
  await vault.write('.atlas/types/task.md', GTD_TASK_TYPE);
  await vault.write('.atlas/types/person.md', PERSON_TYPE);
  await vault.write('People/Mara Quill.md', '---\ntype: person\n---\n\nA colleague.\n');
  for (const title of titles) await vault.write(`Inbox/${title}.md`, TASK);
  return vault;
}

async function openInbox(page: Page, vault: FakeVault) {
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 30_000 });
  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: /^Inbox/ })
    .click();
  const inbox = page.getByRole('article', { name: 'Inbox' });
  await expect(inbox.getByRole('table')).toBeVisible();
  return inbox;
}

test('a change of mind away from Waiting does not write the person picked while it said Waiting', async ({
  page,
}) => {
  const vault = await vaultWith(['Call Tobias Fenn']);
  const inbox = await openInbox(page, vault);
  const status = inbox.getByRole('combobox', { name: 'Status of Call Tobias Fenn' });
  const who = inbox.getByRole('combobox', { name: 'Who Call Tobias Fenn waits on' });

  await status.selectOption({ label: 'Waiting' });
  await pickSuggestion(who, 'Mara Quill');
  await status.selectOption({ label: 'Next Action' });
  // The row no longer asks who it waits on, so nothing on it says Mara Quill.
  await expect(who).toHaveCount(0);
  await inbox.getByRole('button', { name: 'Save', exact: true }).press('Enter');

  await expectFile(vault, 'Inbox/Call Tobias Fenn.md').toContain('status: next-action');
  expect(await vault.read('Inbox/Call Tobias Fenn.md')).not.toContain('waiting_on');
});

test('a title of markup, brackets, emoji and right-to-left text is shown as written, never as HTML', async ({
  page,
}) => {
  let dialogs = 0;
  page.on('dialog', (dialog) => {
    dialogs += 1;
    void dialog.dismiss();
  });
  const inbox = await openInbox(page, await vaultWith([MARKUP]));

  await expect(inbox.getByRole('button', { name: MARKUP, exact: true })).toBeVisible();
  await expect(inbox.locator('tbody img, tbody b')).toHaveCount(0);
  await expect(inbox.getByRole('combobox', { name: `Status of ${MARKUP}` })).toBeVisible();
  expect(dialogs).toBe(0);
});

test('a title with no place to break does not push the row’s controls off the page', async ({
  page,
}) => {
  const inbox = await openInbox(page, await vaultWith([LONG, 'Call Tobias Fenn']));
  const done = inbox
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: LONG, exact: true }) })
    .getByRole('button', { name: 'Save', exact: true });
  await expect(done).toBeVisible();

  const viewport = page.viewportSize();
  const box = await done.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport?.width ?? 0);
  // Nothing in the page scrolls sideways to reach a control.
  const overflow = await inbox.evaluate((article) => {
    const sheet = article.querySelector('.table__sheet');
    return sheet === null ? 0 : sheet.scrollWidth - sheet.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});

for (const width of [1024, 720]) {
  test(`at ${width}px the Inbox does not scroll sideways, Save stays reachable and a row keeps its height when it takes the focus`, async ({
    page,
  }) => {
    const inbox = await openInbox(page, await vaultWith([LONG, 'Call Tobias Fenn']));
    // Opened wide, then squeezed: under 944px the sidebar is a drawer (#658).
    await page.setViewportSize({ width, height: 800 });
    const row = inbox
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: 'Call Tobias Fenn', exact: true }) });
    const save = row.getByRole('button', { name: 'Save', exact: true });
    await expect(save).toBeVisible();
    await save.scrollIntoViewIfNeeded();
    const box = await save.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    const overflow = await inbox.evaluate((article) => {
      const sheet = article.querySelector('.table__sheet');
      return sheet === null ? 0 : sheet.scrollWidth - sheet.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);

    // The keys arrive with the focus: the row they arrive on does not grow or shrink for them.
    const before = (await row.boundingBox())?.height ?? 0;
    await row.focus();
    await expect(row.getByRole('button', { name: 'Next, key N' })).toBeVisible();
    const after = (await row.boundingBox())?.height ?? 0;
    expect(after).toBe(before);
  });
}
