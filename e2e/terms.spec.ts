import { expect, test, type Page } from './fixtures.ts';
import { createVault, emitVaultChanged, expectFile, installHost } from './host.ts';

/**
 * Issue #11 (P28-05): the Terms page. A term is a note of type term, added
 * from the page and listed there; its misheard spellings are edited in place,
 * in its frontmatter only; and a spelling two notes claim is shown as a
 * conflict. The page is reached from the sidebar and from the palette.
 */

const PERSON = [
  '---',
  'type: person',
  'aliases:',
  '  - Mara Quil',
  '---',
  '',
  'Met at the offsite.',
  '',
];

async function openVault(page: Page) {
  const vault = await createVault();
  await vault.mkdir('People');
  await vault.write('People/Mara Quill.md', PERSON.join('\n'));
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

const termsPage = (page: Page) => page.getByRole('article', { name: 'Terms' });

async function addTerm(page: Page, term: { canonical: string; variants: string; kind: string }) {
  await page.getByRole('button', { name: 'New term' }).click();
  const form = page.getByRole('form', { name: 'New term' });
  await form.getByRole('textbox', { name: 'Right spelling' }).fill(term.canonical);
  await form.getByRole('textbox', { name: 'Misheard as' }).fill(term.variants);
  await form.getByRole('combobox', { name: 'Kind' }).selectOption(term.kind);
  await form.getByRole('button', { name: 'Add term' }).click();
}

test('a term is added from the Terms page, listed there, and its variants edited in place', async ({
  page,
}) => {
  const { vault } = await openVault(page);

  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Terms' }).click();
  await expect(termsPage(page).getByText(/^No terms yet/)).toBeVisible();
  // Nothing to count yet, so the bar shows no count beside the page's name.
  await expect(page.locator('.page-bar__count')).toHaveCount(0);

  await addTerm(page, {
    canonical: 'Larkspur',
    variants: 'lark spur, Larks Burr',
    kind: 'company',
  });

  await expectFile(vault, 'Terms/Larkspur.md').toBe(
    '---\ntype: term\nkind: company\nvariants:\n  - lark spur\n  - Larks Burr\n---\n',
  );
  const variants = termsPage(page).getByRole('textbox', { name: 'Misheard spellings of Larkspur' });
  await expect(variants).toHaveValue('lark spur, Larks Burr');
  await expect(
    termsPage(page).getByRole('button', { name: 'Larkspur', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.page-bar__count').getByText('1 term · 2 misheard spellings'),
  ).toBeVisible();

  // Editing the variants writes the frontmatter and nothing else.
  await vault.write(
    'Terms/Larkspur.md',
    '---\ntype: term\nkind: company\nvariants:\n  - lark spur\n---\n\nHeard at the **standup**.\n',
  );
  await emitVaultChanged(page, ['Terms/Larkspur.md']);
  await expect(variants).toHaveValue('lark spur');
  await variants.fill('lark spur, Larkspurr');
  await variants.press('Enter');
  await expectFile(vault, 'Terms/Larkspur.md').toBe(
    '---\ntype: term\nkind: company\nvariants:\n  - lark spur\n  - Larkspurr\n---\n\nHeard at the **standup**.\n',
  );
});

test('a variant two terms claim is shown as a conflict, and the page opens from the palette', async ({
  page,
}) => {
  await openVault(page);

  await page.keyboard.press('Meta+k');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('Terms');
  await page.getByRole('option', { name: 'Terms' }).click();
  await expect(termsPage(page)).toBeVisible();

  await addTerm(page, { canonical: 'Larkspur', variants: 'lark spur', kind: 'company' });
  await expect(
    termsPage(page).getByRole('button', { name: 'Larkspur', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Conflicts' })).toHaveCount(0);

  await addTerm(page, { canonical: 'Larkspur Payroll', variants: 'lark spur', kind: 'company' });
  const conflicts = page.getByRole('region', { name: 'Conflicts' });
  await expect(conflicts.getByRole('heading', { name: '1 conflict' })).toBeVisible();
  await expect(conflicts.getByText('“lark spur”')).toBeVisible();
  await expect(conflicts.getByRole('button', { name: 'Larkspur Payroll (term)' })).toBeVisible();
  await expect(termsPage(page).getByText('In conflict, so not used: “lark spur”')).toHaveCount(2);
});
