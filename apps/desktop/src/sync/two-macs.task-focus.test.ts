/**
 * #108 (fix round of PR #602): the Task type gains DFAI's own `focus` as a
 * vault opens. Two Macs that both open after the upgrade, before either has
 * synced, each add the `focus` lines and write the shipped-properties record;
 * their syncs merge with no conflict, no copy, and one `focus` key.
 */
import { describe, expect, it } from 'vitest';
import {
  parseShippedPropertiesRecord,
  SHIPPED_PROPERTIES,
  SHIPPED_PROPERTIES_RECORD_PATH,
  TASK_TYPE,
  type ShippedCatalogue,
} from '@dfai/domain';
import { ensureBuiltInTypes } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { expectNoMarkers, TIMEOUT, twoMacs, vaultFsOf, type Mac } from './two-macs.harness.ts';

const TASK = '.atlas/types/task.md';
const RECORD = SHIPPED_PROPERTIES_RECORD_PATH as string;

/** A Task type on GTD's statuses, written before DFAI shipped `focus`. */
const OLD_TASK = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '  # Mara Quill asked for estimates in minutes.',
  '  due: date',
  '---',
  '',
  '# Task',
  '',
].join('\n');

/** The build before #108: no Task entry in the catalogue. */
const OLDER_BUILD: ShippedCatalogue = new Map(
  [...SHIPPED_PROPERTIES].filter(([name]) => name !== TASK_TYPE),
);

async function open(mac: Mac, shipped?: ShippedCatalogue) {
  const ensured = await ensureBuiltInTypes({
    fs: vaultFsOf(mac),
    markdown: remarkMarkdown,
    ...(shipped === undefined ? {} : { shipped }),
  });
  expect(ensured.properties.failed, `what ${mac.name} could not do`).toEqual([]);
}

const conflictCopies = async (mac: Mac) =>
  [...(await mac.files()).keys()].filter((path) => path.startsWith('Sync conflicts/'));

/** Each `focus:` key the type's `properties` holds, counted by its line. */
const focusLines = (text: string) => text.split('\n').filter((line) => line === '  focus:').length;

describe('two Macs open a vault after the upgrade that gives Task `focus` (#108)', () => {
  it.each([
    ['both on the new build', undefined, undefined],
    ['the older build reaches GitHub first', OLDER_BUILD, undefined],
    ['the newer build reaches GitHub first', undefined, OLDER_BUILD],
  ])(
    '%s: no conflict, one focus key, the same bytes on both',
    async (_, studioBuild, laptopBuild) => {
      const { studio, laptop } = await twoMacs({ [TASK]: OLD_TASK });
      await open(studio, studioBuild);
      await open(laptop, laptopBuild);
      await studio.sync();
      const report = await laptop.sync();
      await studio.sync();

      expect(report.conflicts).toEqual([]);
      expect(await conflictCopies(laptop)).toEqual([]);
      expect(await conflictCopies(studio)).toEqual([]);
      await expectNoMarkers(laptop);
      await expectNoMarkers(studio);
      const task = await laptop.read(TASK);
      expect(task).toBe(await studio.read(TASK));
      expect(focusLines(task)).toBe(1);
      expect(task).toContain('  # Mara Quill asked for estimates in minutes.\n  due: date\n');
      expect(await laptop.read(RECORD)).toBe(await studio.read(RECORD));
      expect(parseShippedPropertiesRecord(await laptop.read(RECORD)).settled['task']).toContain(
        'focus',
      );
    },
    TIMEOUT,
  );
});
