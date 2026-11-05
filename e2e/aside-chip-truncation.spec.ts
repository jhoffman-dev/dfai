/**
 * As James met it, in the aside's Properties tab of a meeting: a relation chip
 * whose note has a long name wrapped its text onto three lines inside the
 * 28px pill, running over the chips in the row above; and a select's problem
 * ("Provider must be one of …") ran off the panel's edge mid-word. A chip is
 * one line, its name cut with an ellipsis and kept whole on hover and for a
 * screen reader, with its remove still in reach; a problem wraps under its
 * value instead of leaving the panel.
 */
import { expect, test, type Locator, type Page } from './fixtures.ts';
import { createVault, installHost } from './host.ts';
import { revealSidebar } from './sidebar-drawer.ts';

const PERSON_TYPE = '---\nname: person\nlabel: Person\nproperties:\n  role: text\n---\n';
const TASK_TYPE = '---\nname: task\nlabel: Task\nproperties:\n  owner: text\n---\n';
const MEETING_TYPE = [
  '---',
  'name: meeting',
  'label: Meeting',
  'properties:',
  '  title: text',
  '  people:',
  '    kind: relation',
  '    target: person',
  '    many: true',
  '  tasks:',
  '    kind: relation',
  '    target: task',
  '    many: true',
  '  provider:',
  '    kind: select',
  '    options: [granola, gemini-notes, otter-transcripts]',
  '---',
  '',
].join('\n');

const LONG_TASK = 'Larkspur Payroll renewal follow-up with the integrations team';
const LONG_TITLE =
  'Quarterly review of the Larkspur Payroll integration roadmap with Mara and Tobias';

const MEETING = [
  '---',
  'type: meeting',
  `title: ${LONG_TITLE}`,
  'people:',
  '  - "[[Mara Quill]]"',
  '  - "[[Tobias Fenn]]"',
  'tasks:',
  `  - "[[${LONG_TASK}]]"`,
  'provider: zoom-recordings',
  '---',
  '',
  '# Weekly sync',
  '',
].join('\n');

const note = (type: string, heading: string) => `---\ntype: ${type}\n---\n\n# ${heading}\n`;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function openMeetingAside(page: Page): Promise<{ aside: Locator; properties: Locator }> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/person.md', PERSON_TYPE);
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/types/meeting.md', MEETING_TYPE);
  await vault.write('Mara Quill.md', note('person', 'Mara Quill'));
  await vault.write('Tobias Fenn.md', note('person', 'Tobias Fenn'));
  await vault.write(`${LONG_TASK}.md`, note('task', LONG_TASK));
  await vault.write('Weekly sync.md', MEETING);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();

  await revealSidebar(page);
  // The note titles itself: its `title` property is the name the page and the aside show.
  await page.getByRole('treeitem', { name: 'Weekly sync', exact: true }).click();
  await expect(page.getByRole('article', { name: LONG_TITLE })).toBeVisible();
  // Exact: the note's own "Options for…" button would match too.
  await page.getByRole('button', { name: 'Right sidebar', exact: true }).first().click();
  const aside = page.getByRole('complementary', { name: 'Right sidebar' });
  await expect(aside.getByRole('heading', { name: LONG_TITLE })).toBeVisible();
  return { aside, properties: aside.getByRole('region', { name: 'Properties' }) };
}

async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox();
  if (found === null) throw new Error(`no box for ${String(locator)}`);
  return found;
}

const rightEdge = (of: Box) => of.x + of.width;
const bottomEdge = (of: Box) => of.y + of.height;

const within = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  rightEdge(inner) <= rightEdge(outer) + 0.5 &&
  bottomEdge(inner) <= bottomEdge(outer) + 0.5;

const overlap = (a: Box, b: Box) =>
  a.x < rightEdge(b) && b.x < rightEdge(a) && a.y < bottomEdge(b) && b.y < bottomEdge(a);

test('a long relation name is one line, cut with an ellipsis, its remove in reach and nothing overlapping', async ({
  page,
}) => {
  const { aside, properties } = await openMeetingAside(page);
  const asideBox = await box(aside);

  const name = properties.getByRole('button', { name: `Open ${LONG_TASK}` });
  const chip = properties
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: `Open ${LONG_TASK}` }) });
  await expect(chip).toBeVisible();
  const chipBox = await box(chip);
  const nameBox = await box(name);

  // One line of 14px text, inside the pill: not three lines spilling over it.
  expect(nameBox.height).toBeLessThan(24);
  expect(within(nameBox, chipBox)).toBe(true);
  expect(rightEdge(chipBox)).toBeLessThanOrEqual(rightEdge(asideBox));
  const cut = await name.evaluate((el) => ({
    clipped: el.scrollWidth > el.clientWidth,
    textOverflow: getComputedStyle(el).textOverflow,
    hover: el.getAttribute('title'),
  }));
  expect(cut).toEqual({ clipped: true, textOverflow: 'ellipsis', hover: LONG_TASK });

  // The remove stays visible, inside the chip, and clickable.
  const remove = chip.getByRole('button', { name: `Remove ${LONG_TASK} from Tasks` });
  await expect(remove).toBeVisible();
  expect(within(await box(remove), chipBox)).toBe(true);

  // Whole chips wrap onto new lines; no chip's box crosses another's.
  const chips = await properties.getByRole('listitem').all();
  expect(chips.length).toBe(3);
  const boxes = await Promise.all(chips.map(box));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      expect(overlap(boxes[i]!, boxes[j]!), `chips ${i} and ${j} overlap`).toBe(false);
    }
  }
  // The short names are not cut: the ellipsis is only for a name that does not fit.
  const short = properties.getByRole('button', { name: 'Open Mara Quill' });
  expect(await short.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
});

test('a value’s problem and a long text stay inside the panel', async ({ page }) => {
  const { aside, properties } = await openMeetingAside(page);
  const asideBox = await box(aside);

  const problem = properties.getByRole('alert');
  await expect(problem).toHaveText(/^Provider must be one of /);
  const problemBox = await box(problem);
  expect(rightEdge(problemBox)).toBeLessThanOrEqual(rightEdge(asideBox));
  // Wrapped, not cut: every word of it is laid out inside its own box.
  expect(await problem.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);

  // A text value is a one-line field: it ends in an ellipsis until it is focused to edit.
  const title = properties.getByRole('textbox', { name: 'Title' });
  await expect(title).toHaveValue(LONG_TITLE);
  expect(rightEdge(await box(title))).toBeLessThanOrEqual(rightEdge(asideBox));
  expect(
    await title.evaluate((el) => ({
      clipped: el.scrollWidth > el.clientWidth,
      textOverflow: getComputedStyle(el).textOverflow,
    })),
  ).toEqual({ clipped: true, textOverflow: 'ellipsis' });
});
