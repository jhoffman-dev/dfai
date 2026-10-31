import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  emitVaultChanged,
  expectFile,
  installHost,
  sidebarSection,
  type FakeVault,
} from './host.ts';
import { pickSuggestion, suggestedTitles, suggestion } from './link-suggest.ts';

/**
 * #213: PARA is a property of one Project type. A new project is a project;
 * it links an area; archiving it sets its PARA where it stands, which puts it
 * out of the pickers and the sidebar's count; restoring sets it back.
 */

const PROJECT_TYPE = [
  '---',
  'name: project',
  'label: Project',
  'properties:',
  '  para:',
  '    kind: select',
  '    label: PARA',
  '    options: [project, area, resource, archive]',
  '  area:',
  '    kind: relation',
  '    label: Area',
  '    target: area',
  '---',
  '',
  '# Project',
  '',
].join('\n');

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  project:',
  '    kind: relation',
  '    label: Project',
  '    target: [project, area]',
  '---',
  '',
].join('\n');

const note = (frontmatter: string[], body = '') =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n');

async function openParaVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/project.md', PROJECT_TYPE);
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('DFAI.md', note(['type: project', 'para: project'], 'The app.'));
  await vault.write('Garden.md', note(['type: project', 'para: area'], 'Beds and seeds.'));
  await vault.write('Manual.md', note(['type: project', 'para: resource'], 'How the mower works.'));
  await vault.write('Call the bank.md', note(['type: task'], 'About the loan.'));
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const properties = (page: Page) => page.getByRole('region', { name: 'Properties' });
const projectType = (page: Page) =>
  sidebarSection(page, 'types').getByRole('button', { name: /^Project, \d+ notes?$/ });

async function pageMenu(page: Page, item: 'Archive' | 'Unarchive') {
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

test('a new project is a project, links an area, and archives and restores by its PARA where it stands', async ({
  page,
}) => {
  const vault = await openParaVault(page);
  await expect(projectType(page)).toHaveAccessibleName('Project, 3 notes');

  // Create: the type's own New makes a project in its home folder, and it says so (#214).
  await projectType(page).click();
  await page
    .getByRole('article', { name: 'Project', exact: true })
    .getByRole('button', { name: 'New project', exact: true })
    .click();
  await expect(page.getByRole('article', { name: 'New Project' })).toBeVisible();
  await expectFile(vault, 'Projects/New Project.md').toContain('para: project');
  await expect(properties(page).getByRole('combobox', { name: 'PARA' })).toHaveValue('project');

  // Set Area: its picker offers areas only, and it is optional.
  const area = properties(page).getByRole('combobox', { name: 'Area' });
  await area.click();
  await expect.poll(() => suggestedTitles(area).allTextContents()).toContain('Garden');
  expect(await suggestedTitles(area).allTextContents()).not.toContain('DFAI');
  expect(await suggestedTitles(area).allTextContents()).not.toContain('Manual');
  await pickSuggestion(area, 'Garden');
  await expectFile(vault, 'Projects/New Project.md').toContain('area: "[[Garden]]"');
  await expect(projectType(page)).toHaveAccessibleName('Project, 4 notes');

  // Archive: PARA becomes archive, and the file stays in Projects/ where it is.
  await pageMenu(page, 'Archive');
  await expectFile(vault, 'Projects/New Project.md').toContain('para: archive');
  await expectFile(vault, 'Projects/New Project.md').toContain('para_before_archive: project');
  expect(await vault.exists('Archive/New Project.md')).toBe(false);
  await expectFile(vault, 'Projects/New Project.md').toContain('area: "[[Garden]]"');
  // The host's watcher reports the app's own write, as it reports any other.
  await emitVaultChanged(page, ['Projects/New Project.md']);
  await expect(projectType(page)).toHaveAccessibleName('Project, 3 notes');

  // An archived project is not offered to a task; a resource never is; areas are.
  await page.getByRole('treeitem', { name: 'Call the bank', exact: true }).click();
  const project = properties(page).getByRole('combobox', { name: 'Project' });
  await project.click();
  await expect.poll(() => suggestedTitles(project).allTextContents()).toContain('DFAI');
  const offered = await suggestedTitles(project).allTextContents();
  expect(offered).toContain('Garden');
  expect(offered).not.toContain('New Project');
  expect(offered).not.toContain('Manual');
  // Each says which it is, so Garden the area is not taken for a project (#213).
  await expect(suggestion(project, 'DFAI')).toHaveAttribute('aria-label', /, Projects,/);
  await expect(suggestion(project, 'Garden')).toHaveAttribute('aria-label', /, Areas,/);

  // Restore: Unarchive sets PARA back to project, and it is offered again.
  await page.getByRole('treeitem', { name: 'Projects', exact: true }).click();
  await page.getByRole('treeitem', { name: 'New Project', exact: true }).click();
  await expect(page.getByRole('article', { name: 'New Project' })).toBeVisible();
  await pageMenu(page, 'Unarchive');
  await expectFile(vault, 'Projects/New Project.md').toContain('para: project');
  await expectFile(vault, 'Projects/New Project.md').not.toContain('para_before_archive');
  expect(await vault.exists('Archive/New Project.md')).toBe(false);
  await emitVaultChanged(page, ['Projects/New Project.md']);
  await expect(projectType(page)).toHaveAccessibleName('Project, 4 notes');

  await page.getByRole('treeitem', { name: 'Call the bank', exact: true }).click();
  const again = properties(page).getByRole('combobox', { name: 'Project' });
  await again.click();
  await expect.poll(() => suggestedTitles(again).allTextContents()).toContain('New Project');
});

async function paletteCommand(page: Page, label: string) {
  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill(label);
  await page
    .getByRole('dialog', { name: 'Search notes' })
    .getByRole('option', { name: new RegExp(label) })
    .click();
}

test('an area archived from the palette stays an area: listed in the Archive, and back from there as one', async ({
  page,
}) => {
  const vault = await openParaVault(page);
  await page.getByRole('treeitem', { name: 'Garden', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Garden' })).toBeVisible();

  // ⌘K → Archive this note archives it by its PARA, keeping that it was an area.
  await paletteCommand(page, 'Archive this note');
  await expectFile(vault, 'Garden.md').toContain('para: archive');
  await expectFile(vault, 'Garden.md').toContain('para_before_archive: area');
  expect(await vault.exists('Archive/Garden.md')).toBe(false);
  await emitVaultChanged(page, ['Garden.md']);

  // The Archive page lists it, so it can be found and brought back.
  await paletteCommand(page, 'Open Archive');
  const archive = page.getByRole('article', { name: 'Archive' });
  await expect(archive.getByRole('button', { name: 'Garden', exact: true })).toBeVisible();
  await archive.getByRole('button', { name: 'Unarchive Garden' }).click();

  // Back an area, not a project: what it was before is given back and the record taken off.
  await expectFile(vault, 'Garden.md').toContain('para: area');
  await expectFile(vault, 'Garden.md').not.toContain('para_before_archive');
  expect(await vault.exists('Archive/Garden.md')).toBe(false);
});
