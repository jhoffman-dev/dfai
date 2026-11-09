import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';

/**
 * #413: what a person scans a table for is a muted pastel pill, not grey —
 * a select's option, and each note a relation links — and the same value is
 * the same colour in the table and in the note's properties panel.
 */

const MEETING_TYPE = [
  '---',
  'name: meeting',
  'properties:',
  '  kind:',
  '    kind: select',
  '    options: [Interview, 1on1]',
  '  companies:',
  '    kind: relation',
  '    target: company',
  '    many: true',
  '---',
  '',
].join('\n');

const COMPANY_TYPE = ['---', 'name: company', '---', ''].join('\n');

const VIEW = [
  '---',
  'atlas: view',
  'type: meeting',
  'columns: [kind, companies]',
  '---',
  '',
  '# Meetings',
  '',
].join('\n');

const meeting = (title: string, kind: string, companies: readonly string[]) =>
  [
    '---',
    'type: meeting',
    `kind: ${kind}`,
    'companies:',
    ...companies.map((company) => `  - "[[${company}]]"`),
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n');

async function openMeetings(page: Page) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/meeting.md', MEETING_TYPE);
  await vault.write('.atlas/types/company.md', COMPANY_TYPE);
  await vault.write('.atlas/views/Meetings.md', VIEW);
  await vault.write('Larkspur Payroll.md', '---\ntype: company\n---\n\n# Larkspur Payroll\n');
  await vault.write('Fenn Studio.md', '---\ntype: company\n---\n\n# Fenn Studio\n');
  await vault.write('kickoff.md', meeting('Kickoff', 'Interview', ['Larkspur Payroll']));
  await vault.write(
    'catch-up.md',
    meeting('Catch-up', '1on1', ['Larkspur Payroll', 'Fenn Studio']),
  );
  await vault.write('review.md', meeting('Review', 'Interview', ['Fenn Studio']));

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'views')
    .getByRole('button', { name: 'Meetings', exact: true })
    .click();
  await expect(page.getByText('3 meetings')).toBeVisible();
}

/** The hue every pill in `pills` wears, once each: one entry when they all agree. */
async function huesOf(pills: ReturnType<Page['locator']>): Promise<(string | null)[]> {
  const all = await pills.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-hue')),
  );
  return [...new Set(all)];
}

test('a table draws its select and relation cells as coloured pills, one colour per value', async ({
  page,
}) => {
  await openMeetings(page);
  const table = page.locator('.table');

  const interviews = table.locator('.status-pill', { hasText: /^Interview$/ });
  await expect(interviews).toHaveCount(2);
  const [interviewHue, ...others] = await huesOf(interviews);
  expect(others).toEqual([]);
  expect(interviewHue).toMatch(/^(brown|orange|yellow|green|blue|purple|pink|red)$/);

  const larkspur = table.locator('.table__note', { hasText: 'Larkspur Payroll' });
  await expect(larkspur).toHaveCount(2);
  const larkspurHues = await huesOf(larkspur);
  expect(larkspurHues).toHaveLength(1);
  expect(larkspurHues[0]).not.toBeNull();

  // Painted, not only labelled: the pill's fill is not the page's and not grey's.
  await expect(async () => {
    const fill = await interviews
      .first()
      .evaluate((node) => getComputedStyle(node).backgroundColor);
    const grey = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--hue-gray-bg').trim(),
    );
    expect(fill).not.toBe('rgba(0, 0, 0, 0)');
    expect(grey).not.toBe('');
    expect(fill).not.toBe(hexToRgb(grey));
  }).toPass();

  // The same value is the same colour in the note's properties panel.
  await table.getByRole('button', { name: 'kickoff', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Properties' }).first();
  await expect(panel).toBeVisible();
  await expect(panel.locator('.props__pill', { hasText: 'Interview' })).toHaveAttribute(
    'data-hue',
    interviewHue ?? '',
  );
  await expect(panel.locator('.props__link', { hasText: 'Larkspur Payroll' })).toHaveAttribute(
    'data-hue',
    larkspurHues[0] ?? '',
  );
});

function hexToRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
}
