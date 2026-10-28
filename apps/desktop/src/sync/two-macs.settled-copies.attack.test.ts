/**
 * Attack on #235 (PR #599) over real git: a cleared `.atlas` conflict copy
 * whose removal could not be pushed, while the other Mac adds to the copy or
 * makes a new one by the same name, must come back holding the other Mac's
 * data on both Macs — never lost to the clearing.
 */
import { describe, expect, it } from 'vitest';
import { SHIPPED_PROPERTIES_RECORD_PATH, shippedPropertiesRecordText } from '@dfai/domain';
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
    'Mara Quill.',
    '',
  ].join('\n');
const DATE = ['  date:', '    kind: date'];
const SUMMARY = ['  atlas_summary_of:', '    kind: text'];
const LIVE_TEXT = meeting([...DATE, ...SUMMARY]);
const OLD_COPY = meeting(DATE);

/** The vault's record: DFAI added the summary key to the Meeting type itself (#235). */
const RECORD = {
  [SHIPPED_PROPERTIES_RECORD_PATH as string]: shippedPropertiesRecordText({
    settled: { meeting: ['atlas_summary_of'] },
    added: { meeting: ['atlas_summary_of'] },
  }),
};

const has = async (mac: Mac, path: string) => (await mac.files()).has(path);
const refusedPush = {
  git: { push: async () => ({ code: 128, stdout: '', stderr: 'fatal: unable to access' }) },
};

describe('attack #235 over git: a clearing that could not be pushed', () => {
  it(
    'keeps the copy the other Mac added to while this Mac’s removal waited to be pushed',
    async () => {
      const { studio, laptop } = await twoMacs({ ...RECORD, [LIVE]: LIVE_TEXT, [COPY]: OLD_COPY });
      await studio.sync(refusedPush).catch(() => undefined);
      expect(await has(studio, COPY)).toBe(false);
      const added = OLD_COPY.replace('label: Meeting', 'label: Meeting\nicon: calendar');
      await laptop.write(COPY, added);
      await laptop.sync();
      await studio.sync();
      await laptop.sync();
      for (const mac of [studio, laptop]) {
        expect(await mac.read(COPY)).toBe(added);
        await expectNoMarkers(mac);
      }
    },
    TIMEOUT,
  );

  it(
    'keeps a new copy by the same name the other Mac made while this Mac’s removal waited',
    async () => {
      const { studio, laptop } = await twoMacs({ ...RECORD, [LIVE]: LIVE_TEXT, [COPY]: OLD_COPY });
      await studio.sync(refusedPush).catch(() => undefined);
      // The Laptop's person deletes the old copy, then saves another under its name.
      await laptop.remove(COPY);
      await laptop.sync();
      const fresh = meeting([...DATE, '  venue:', '    kind: text']);
      await laptop.write(COPY, fresh);
      await laptop.sync();
      await studio.sync();
      await laptop.sync();
      for (const mac of [studio, laptop]) {
        expect(await mac.read(COPY)).toBe(fresh);
        await expectNoMarkers(mac);
      }
    },
    TIMEOUT,
  );

  it(
    'clears a copy never committed once it is, and keeps the live file whole',
    async () => {
      const { studio, laptop } = await twoMacs({ ...RECORD, [LIVE]: LIVE_TEXT });
      // A copy that reached this Mac outside git (a person put it back by hand), not yet committed.
      await studio.write(COPY, OLD_COPY);
      await studio.sync();
      await laptop.sync();
      for (const mac of [studio, laptop]) {
        expect(await has(mac, COPY)).toBe(false);
        expect(await mac.read(LIVE)).toBe(LIVE_TEXT);
      }
    },
    TIMEOUT,
  );
});
