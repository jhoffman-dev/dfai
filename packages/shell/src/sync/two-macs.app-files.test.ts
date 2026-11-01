/**
 * #233: what DFAI writes by itself into `.atlas/` as a vault opens never
 * comes back as a sync conflict because the vault was opened on another Mac.
 *
 * Two simulated Macs share one bare remote. Each runs the app's own launch
 * step for the vault's types (`ensureBuiltInTypes`, which gives the Meeting
 * type the properties DFAI ships and records them in
 * `.atlas/migrations/type-properties.md`) over its own clone, then the real
 * `syncNow` over real git. An older build is the same code with the
 * catalogue it shipped: Meeting without the summary keys (#183).
 */
import { describe, expect, it } from 'vitest';
import {
  MEETING_SUMMARY_PROPERTIES,
  parseShippedPropertiesRecord,
  SHIPPED_PROPERTIES,
  SHIPPED_PROPERTIES_RECORD_PATH,
  type ShippedCatalogue,
} from '@dfai/domain';
import { ensureBuiltInTypes } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { expectNoMarkers, TIMEOUT, twoMacs, vaultFsOf, type Mac } from './two-macs.harness.ts';

const MEETING = '.atlas/types/meeting.md';
const RECORD = SHIPPED_PROPERTIES_RECORD_PATH as string;

/** A Meeting type written before DFAI shipped any of its own keys on it. */
const OLD_MEETING = [
  '---',
  'name: meeting',
  'label: Meeting',
  'properties:',
  '  attendees:',
  '    kind: relation',
  '    label: Attendees',
  '    target: person',
  '    many: true',
  '  date:',
  '    kind: date',
  '    label: Date',
  '---',
  '',
  'A meeting with Mara Quill or Tobias Fenn at Larkspur Payroll.',
  '',
].join('\n');

const SUMMARY_KEYS = new Set(MEETING_SUMMARY_PROPERTIES.map((property) => property.key));

/** The build before the meeting summary (#183): Meeting without its summary keys. */
const OLDER_BUILD: ShippedCatalogue = new Map(
  [...SHIPPED_PROPERTIES].map(([name, properties]) => [
    name,
    properties.filter((property) => !SUMMARY_KEYS.has(property.key)),
  ]),
);

/** What opening the vault does to its types, on `mac`, with `shipped` as its build's catalogue. */
async function open(mac: Mac, shipped?: ShippedCatalogue) {
  const ensured = await ensureBuiltInTypes({
    fs: vaultFsOf(mac),
    markdown: remarkMarkdown,
    ...(shipped === undefined ? {} : { shipped }),
  });
  expect(ensured.properties.failed, `what ${mac.name} could not do`).toEqual([]);
  return ensured;
}

const meetingKeys = async (mac: Mac) =>
  Object.keys(
    (remarkMarkdown.frontmatterProperties(
      (await mac.read(MEETING)).split('\n---\n')[0]! + '\n---\n',
    )['properties'] ?? {}) as Record<string, unknown>,
  );

const settledMeetingKeys = async (mac: Mac) =>
  parseShippedPropertiesRecord(await mac.read(RECORD)).settled['meeting'] ?? [];

const conflictCopies = async (mac: Mac) =>
  [...(await mac.files()).keys()].filter((path) => path.startsWith('Sync conflicts/'));

/** Both Macs open the vault before either has synced; then each syncs, Studio first, and Studio again. */
async function openOnBothThenSync({
  studioBuild,
  laptopBuild,
}: {
  studioBuild?: ShippedCatalogue | undefined;
  laptopBuild?: ShippedCatalogue | undefined;
}) {
  const world = await twoMacs({ [MEETING]: OLD_MEETING });
  const { studio, laptop } = world;
  await open(studio, studioBuild);
  await open(laptop, laptopBuild);
  await studio.sync();
  const report = await laptop.sync();
  await studio.sync();
  return { ...world, report };
}

describe('two Macs open the vault and sync (#233)', () => {
  it(
    'on the same build: nothing the app wrote is a conflict, and both Macs hold the same bytes',
    async () => {
      const { studio, laptop, report } = await openOnBothThenSync({});
      expect(report.conflicts).toEqual([]);
      expect(await conflictCopies(laptop)).toEqual([]);
      await expectNoMarkers(laptop);
      expect(await studio.read(MEETING)).toBe(await laptop.read(MEETING));
      expect(await studio.read(RECORD)).toBe(await laptop.read(RECORD));
    },
    TIMEOUT,
  );

  it.each([
    ['the older build reaches GitHub first', OLDER_BUILD, undefined],
    ['the newer build reaches GitHub first', undefined, OLDER_BUILD],
  ])(
    'on different builds (%s): no conflict copy, and they converge on the newer build’s keys',
    async (_, studioBuild, laptopBuild) => {
      const { studio, laptop, report } = await openOnBothThenSync({ studioBuild, laptopBuild });
      expect(report.conflicts).toEqual([]);
      expect(await conflictCopies(laptop)).toEqual([]);
      expect(await conflictCopies(studio)).toEqual([]);
      await expectNoMarkers(laptop);
      expect(await studio.read(MEETING)).toBe(await laptop.read(MEETING));
      expect(await studio.read(RECORD)).toBe(await laptop.read(RECORD));
      const keys = await meetingKeys(laptop);
      for (const key of SUMMARY_KEYS) expect(keys).toContain(key);
      expect(keys.slice(0, 2)).toEqual(['attendees', 'date']);
      for (const key of SUMMARY_KEYS) expect(await settledMeetingKeys(laptop)).toContain(key);
      // The person's own text is untouched.
      expect(await laptop.read(MEETING)).toContain(
        'A meeting with Mara Quill or Tobias Fenn at Larkspur Payroll.',
      );
    },
    TIMEOUT,
  );

  it(
    'a person’s edit to the type on one Mac and the app’s upgrade on the other are both kept, with no copy',
    async () => {
      const { studio, laptop } = await twoMacs({ [MEETING]: OLD_MEETING });
      await studio.write(MEETING, OLD_MEETING.replace('label: Meeting', 'label: Meetings'));
      await studio.sync();
      await open(laptop);
      const report = await laptop.sync();
      expect(report.conflicts).toEqual([]);
      const merged = await laptop.read(MEETING);
      expect(merged).toContain('label: Meetings\n');
      for (const key of SUMMARY_KEYS) expect(await meetingKeys(laptop)).toContain(key);
    },
    TIMEOUT,
  );

  it(
    'two people changing the same key differently is a real conflict: both versions are kept',
    async () => {
      const { studio, laptop } = await twoMacs({ [MEETING]: OLD_MEETING });
      const studios = OLD_MEETING.replace('label: Meeting', 'label: Calls');
      const laptops = OLD_MEETING.replace('label: Meeting', 'label: Catch-ups');
      await studio.write(MEETING, studios);
      await studio.sync();
      await laptop.write(MEETING, laptops);
      const report = await laptop.sync();
      expect(report.conflicts.map((conflict) => conflict.path)).toEqual([MEETING]);
      await expectNoMarkers(laptop);
      expect(await laptop.read(MEETING)).toBe(laptops);
      expect(await laptop.read(report.conflicts[0]!.copy)).toBe(studios);
    },
    TIMEOUT,
  );

  it(
    'a merge that throws part-way gives up to the copy: no markers, nothing lost, and later syncs run',
    async () => {
      const { studio, laptop } = await twoMacs({ [MEETING]: OLD_MEETING });
      await open(studio, OLDER_BUILD);
      await open(laptop);
      await studio.sync();
      const laptops = await laptop.read(MEETING);
      const report = await laptop.sync({
        fs: {
          readTextFile: async () => {
            throw new Error('the host could not read it');
          },
        },
      });
      expect(report.conflicts.length).toBeGreaterThan(0);
      await expectNoMarkers(laptop);
      expect(await laptop.read(MEETING)).toBe(laptops);
      await expect(laptop.sync()).resolves.toMatchObject({ conflicts: [] });
      await expect(studio.sync()).resolves.toMatchObject({ conflicts: [] });
      await expectNoMarkers(studio);
    },
    TIMEOUT,
  );

  it(
    'an older build opening after the newer one’s upgrade synced changes nothing: no downgrade',
    async () => {
      const { studio, laptop } = await twoMacs({ [MEETING]: OLD_MEETING });
      await open(studio);
      await studio.sync();
      await laptop.sync();
      const before = { meeting: await laptop.read(MEETING), record: await laptop.read(RECORD) };
      const ensured = await open(laptop, OLDER_BUILD);
      expect(ensured.properties.gained).toEqual([]);
      expect(await laptop.read(MEETING)).toBe(before.meeting);
      expect(await laptop.read(RECORD)).toBe(before.record);
      const report = await laptop.sync();
      expect(report.committed).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'opening the vault again on the same Mac writes nothing',
    async () => {
      const { studio } = await twoMacs({ [MEETING]: OLD_MEETING });
      await open(studio);
      const before = { meeting: await studio.read(MEETING), record: await studio.read(RECORD) };
      const again = await open(studio);
      expect(again.properties.gained).toEqual([]);
      expect(await studio.read(MEETING)).toBe(before.meeting);
      expect(await studio.read(RECORD)).toBe(before.record);
    },
    TIMEOUT,
  );
});
