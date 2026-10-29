/**
 * #235: a conflict copy of one of DFAI's own files, made before #234 let sync
 * merge such files by their keys, goes to the Trash on a sync once its live
 * file holds everything in it — and stays while it holds anything more.
 *
 * Two simulated Macs share one bare remote, and run the real `syncNow` over
 * real git and the vault's real files.
 */
import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  journalText,
  SHIPPED_PROPERTIES_RECORD_PATH,
  shippedPropertiesRecordText,
} from '@dfai/domain';
import { expectNoMarkers, TIMEOUT, twoMacs, type Mac } from './two-macs.harness.ts';

const LIVE = '.atlas/types/meeting.md';
const COPY = 'Sync conflicts/atlas/types/meeting (conflict from Laptop).md';

const meeting = (properties: readonly string[]) =>
  [
    '---',
    'name: meeting',
    'label: Meeting',
    'properties:',
    ...properties,
    '---',
    '',
    'A meeting with Mara Quill at Larkspur Payroll.',
    '',
  ].join('\n');

const ATTENDEES = ['  attendees:', '    kind: relation', '    target: person'];
const DATE = ['  date:', '    kind: date'];
const SUMMARY = ['  atlas_summary_of:', '    kind: text'];

/** The Meeting type now, with the key a newer build added. */
const LIVE_TEXT = meeting([...ATTENDEES, ...DATE, ...SUMMARY]);
/** The older build's Meeting, kept as a copy by a sync before #234. */
const OLD_COPY = meeting([...ATTENDEES, ...DATE]);

/** The vault's record: DFAI added the summary key to the Meeting type itself. */
const RECORD = {
  [SHIPPED_PROPERTIES_RECORD_PATH as string]: shippedPropertiesRecordText({
    settled: { meeting: ['atlas_summary_of'] },
    added: { meeting: ['atlas_summary_of'] },
  }),
};

const has = async (mac: Mac, path: string) => (await mac.files()).has(path);

describe('a sync clears an old .atlas conflict copy that adds nothing (#235)', () => {
  it(
    'moves it to the Trash, says so in Activity, and the other Mac loses it too',
    async () => {
      const { studio, laptop, trash } = await twoMacs({
        ...RECORD,
        [LIVE]: LIVE_TEXT,
        [COPY]: OLD_COPY,
      });
      const report = await studio.sync();
      expect(report.conflicts).toEqual([]);
      expect(await has(studio, COPY)).toBe(false);
      expect(await studio.read(LIVE)).toBe(LIVE_TEXT);
      expect(await readdir(trash)).toHaveLength(1);
      expect(studio.activity).toContain(
        `info: Cleared the conflict copy ${COPY}: ${LIVE} already holds everything in it. It is in the Trash.`,
      );
      await laptop.sync();
      expect(await has(laptop, COPY)).toBe(false);
      expect(await laptop.read(LIVE)).toBe(LIVE_TEXT);
      await expectNoMarkers(laptop);
    },
    TIMEOUT,
  );

  it(
    'keeps it when the other Mac’s live file, merged in by this sync, no longer holds all of it',
    async () => {
      const { studio, laptop, trash } = await twoMacs({
        ...RECORD,
        [LIVE]: LIVE_TEXT,
        [COPY]: OLD_COPY,
      });
      // The Laptop takes the date off the type and sends it before the Studio syncs.
      const withoutDate = meeting([...ATTENDEES, ...SUMMARY]);
      await laptop.write(LIVE, withoutDate);
      await laptop.sync();
      // The Laptop's own live file now lacks the copy's date: it keeps the copy too.
      expect(await has(laptop, COPY)).toBe(true);
      await studio.sync();
      expect(await studio.read(LIVE)).toBe(withoutDate);
      expect(await has(studio, COPY)).toBe(true);
      expect(await studio.read(COPY)).toBe(OLD_COPY);
      expect(await readdir(trash)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'both Macs clearing the same copy before either hears of the other: no conflict, gone on both',
    async () => {
      const { studio, laptop } = await twoMacs({ ...RECORD, [LIVE]: LIVE_TEXT, [COPY]: OLD_COPY });
      // The Laptop fetches, merges nothing new and clears its own copy; only then does the
      // Studio clear and push, so the Laptop's push is refused as behind.
      const refused = await laptop
        .sync({
          git: {
            push: async () => {
              await studio.sync();
              return laptop.git.push();
            },
          },
        })
        .then(
          () => null,
          (cause: unknown) => cause,
        );
      expect(refused).toBeInstanceOf(Error);
      expect(await has(laptop, COPY)).toBe(false);
      expect(await has(studio, COPY)).toBe(false);
      const report = await laptop.sync();
      await studio.sync();
      expect(report.conflicts).toEqual([]);
      for (const mac of [studio, laptop]) {
        expect(
          [...(await mac.files()).keys()].filter((path) => path.startsWith('Sync conflicts/')),
        ).toEqual([]);
        expect(await mac.read(LIVE)).toBe(LIVE_TEXT);
        await expectNoMarkers(mac);
      }
    },
    TIMEOUT,
  );

  it(
    'keeps a copy this very sync reports — one the app quit before reporting — and clears it the sync after',
    async () => {
      const { studio, trash } = await twoMacs({ ...RECORD, [LIVE]: LIVE_TEXT, [COPY]: OLD_COPY });
      // A sync made the copy and the app quit before saying so: the journal still holds it.
      await studio.syncFiles.write(
        'journal.json',
        journalText({
          mergeHead: null,
          files: [],
          unreported: [{ path: LIVE, copy: COPY, whose: 'theirs' }],
        }),
      );
      const report = await studio.sync();
      expect(report.conflicts).toEqual([{ path: LIVE, copy: COPY, whose: 'theirs' }]);
      expect(await has(studio, COPY)).toBe(true);
      expect(await readdir(trash)).toEqual([]);
      await studio.sync();
      expect(await has(studio, COPY)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'keeps a copy the other Mac changed while this one cleared it',
    async () => {
      const { studio, laptop } = await twoMacs({ ...RECORD, [LIVE]: LIVE_TEXT, [COPY]: OLD_COPY });
      const edited = OLD_COPY.replace('label: Meeting', 'label: Meetings');
      // The Laptop's person edits the copy; the Studio, not yet seeing it, clears and sends.
      await laptop.write(COPY, edited);
      await studio.sync();
      expect(await has(studio, COPY)).toBe(false);
      await laptop.sync();
      await studio.sync();
      for (const mac of [studio, laptop]) {
        expect(await mac.read(COPY)).toBe(edited);
        await expectNoMarkers(mac);
      }
    },
    TIMEOUT,
  );
});
