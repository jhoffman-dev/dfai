/**
 * Attacks on #233's merge of `.atlas/**.md` by keys, through the real
 * `syncNow` over real git: two clones (three, once) of a bare remote. The
 * prime directive: nothing a person wrote is ever lost, and no conflict
 * markers are left in a file.
 */
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { remarkMarkdown } from '@dfai/adapters';
import {
  bothChange,
  expectNoMarkers,
  expectVersionsSurvive,
  killPoint,
  macAt,
  must,
  TIMEOUT,
  twoMacs,
  type Mac,
} from './two-macs.harness.ts';

const MEETING = '.atlas/types/meeting.md';

const typeFile = (entries: string[], { head = [] as string[], body = 'Meetings.' } = {}) =>
  [
    '---',
    'name: meeting',
    'label: Meeting',
    ...head,
    'properties:',
    '  date:',
    '    kind: date',
    '    label: Date',
    ...entries,
    '---',
    '',
    body,
    '',
  ].join('\n');

const BASE = typeFile([]);
const TASKS = ['  tasks:', '    kind: relation', '    target: task'];
const ROOM = ['  room:', '    kind: text'];

const conflictCopies = async (mac: Mac) =>
  [...(await mac.files()).keys()].filter((path) => path.startsWith('Sync conflicts/'));

const entriesOf = async (mac: Mac, path = MEETING) => {
  const text = await mac.read(path);
  const block = text.slice(0, text.indexOf('\n---\n', 4) + 5);
  return Object.keys(
    (remarkMarkdown.frontmatterProperties(block)['properties'] ?? {}) as Record<string, unknown>,
  );
};

const everyFileText = async (mac: Mac) =>
  [...(await mac.files()).values()].map((bytes) => bytes.toString('utf8')).join('\n');

describe('two Macs merge .atlas settings by keys: what a person wrote survives (#233 attack)', () => {
  it(
    'a comment a person wrote beside the app’s upgrade survives the sync, in place or in a copy',
    async () => {
      const note = '  # Tobias Fenn: date is the day it was held, not the invite day';
      // Studio's person writes the comment where Laptop's app appends: git's line merge clashes.
      const { laptop } = await bothChange(MEETING, {
        base: BASE,
        studio: typeFile([note]),
        laptop: typeFile(TASKS),
      });
      const report = await laptop.sync();
      await expectNoMarkers(laptop);
      expect(await entriesOf(laptop)).toContain('tasks');
      expect(await everyFileText(laptop), JSON.stringify(report.conflicts)).toContain(note);
    },
    TIMEOUT,
  );

  it(
    'an alias the other Mac added to an anchor on an existing key neither stalls the sync nor is lost',
    async () => {
      const theirs = typeFile([], { head: ['title: *heading'] }).replace(
        'label: Meeting',
        'label: &heading Meeting',
      );
      const { laptop } = await bothChange(MEETING, {
        base: typeFile([], { head: ['icon: calendar'] }),
        studio: theirs.replace('title: *heading', 'icon: calendar\ntitle: *heading'),
        laptop: typeFile([], { head: ['icon: calendar', 'color: teal'] }),
      });
      await expect(laptop.sync()).resolves.toBeDefined();
      await expectNoMarkers(laptop);
      expect(await everyFileText(laptop)).toContain('title: *heading');
      // And the next sync is not stuck on the merge the first left behind.
      await expect(laptop.sync()).resolves.toBeDefined();
    },
    TIMEOUT,
  );
});

describe('two Macs merge .atlas settings by keys: what held (#233 attack)', () => {
  it(
    'one Mac removes a property while the other adds one: the removal stands, the addition is kept, no copy',
    async () => {
      const { laptop } = await bothChange(MEETING, {
        base: typeFile(ROOM),
        studio: typeFile([]),
        laptop: typeFile([...ROOM, ...TASKS]),
      });
      const report = await laptop.sync();
      expect(report.conflicts).toEqual([]);
      await expectNoMarkers(laptop);
      expect(await entriesOf(laptop)).toEqual(['date', 'tasks']);
    },
    TIMEOUT,
  );

  it(
    'both Macs add the same property with different specs: a copy, both versions whole',
    async () => {
      const studios = typeFile(['  room:', '    kind: text']);
      const laptops = typeFile(['  room:', '    kind: relation', '    target: place']);
      const { laptop } = await bothChange(MEETING, {
        base: BASE,
        studio: studios,
        laptop: laptops,
      });
      const report = await laptop.sync();
      expect(report.conflicts.map((conflict) => conflict.path)).toEqual([MEETING]);
      await expectNoMarkers(laptop);
      await expectVersionsSurvive(laptop, [studios, laptops]);
    },
    TIMEOUT,
  );

  it(
    'a settings file both Macs created at once (no base) is merged when each only added keys',
    async () => {
      const path = '.atlas/views/board.md';
      const { studio, laptop } = await twoMacs({ 'Notes/seed.md': 'seed\n' });
      await studio.write(path, '---\nname: board\ngroup: status\n---\n');
      await studio.sync();
      await laptop.write(path, '---\nname: board\nsort: due\n---\n');
      const report = await laptop.sync();
      expect(report.conflicts).toEqual([]);
      await expectNoMarkers(laptop);
      const merged = await laptop.read(path);
      expect(merged).toContain('group: status');
      expect(merged).toContain('sort: due');
    },
    TIMEOUT,
  );

  it(
    'a note outside .atlas shaped like a type is never merged by keys: a copy keeps both',
    async () => {
      const path = 'Notes/meeting.md';
      const studios = typeFile(ROOM);
      const laptops = typeFile(TASKS);
      const { laptop } = await bothChange(path, { base: BASE, studio: studios, laptop: laptops });
      const report = await laptop.sync();
      expect(report.conflicts.map((conflict) => conflict.path)).toEqual([path]);
      await expectVersionsSurvive(laptop, [studios, laptops]);
    },
    TIMEOUT,
  );

  it(
    'a file under .atlas that is not markdown is copied, not merged',
    async () => {
      const path = '.atlas/settings.yaml';
      const base = 'name: meeting\nproperties:\n  date: {}\n';
      const studios = `${base}  room: {}\n`;
      const laptops = `${base}  tasks: {}\n`;
      const { laptop } = await bothChange(path, { base, studio: studios, laptop: laptops });
      const report = await laptop.sync();
      expect(report.conflicts.map((conflict) => conflict.path)).toEqual([path]);
      await expectVersionsSurvive(laptop, [studios, laptops]);
    },
    TIMEOUT,
  );

  it(
    'after a merge by keys both Macs settle on one file: syncing again on each commits nothing',
    async () => {
      const { studio, laptop } = await bothChange(MEETING, {
        base: BASE,
        studio: typeFile(ROOM),
        laptop: typeFile(TASKS),
      });
      await laptop.sync();
      await studio.sync();
      expect(await studio.read(MEETING)).toBe(await laptop.read(MEETING));
      const again = [await laptop.sync(), await studio.sync(), await laptop.sync()];
      expect(again.map((report) => report.committed)).toEqual([false, false, false]);
      expect(await conflictCopies(studio)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'quitting after the merge is written but before it is committed: the rerun finishes it, no copy',
    async () => {
      const { laptop } = await bothChange(MEETING, {
        base: BASE,
        studio: typeFile(ROOM),
        laptop: typeFile(TASKS),
      });
      const quit = killPoint();
      void laptop.sync({
        fs: {
          writeTextFile: async (request) => {
            await laptop.fs.writeTextFile(request);
            return quit.hang();
          },
        },
      });
      await quit.hit;
      const report = await laptop.sync();
      expect(report.conflicts).toEqual([]);
      await expectNoMarkers(laptop);
      expect(await entriesOf(laptop)).toEqual(['date', 'tasks', 'room']);
      expect(await conflictCopies(laptop)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'typing into the file while the sync settles it: the typing is kept, and the other Mac’s version too',
    async () => {
      const studios = typeFile(ROOM);
      const { laptop } = await bothChange(MEETING, {
        base: BASE,
        studio: studios,
        laptop: typeFile(TASKS),
      });
      const typed = typeFile(TASKS, { body: 'Meetings, typed by Mara Quill mid-sync.' });
      // The first hash of the file records what git merged into it; the
      // second is the merge-by-keys guard. Mara types just before that one.
      let hashes = 0;
      let typedOnce = false;
      await laptop.sync({
        git: {
          hashFile: async (path) => {
            if (path === MEETING && ++hashes === 2) {
              typedOnce = true;
              await laptop.write(MEETING, typed);
            }
            return laptop.git.hashFile(path);
          },
        },
      });
      expect(typedOnce).toBe(true);
      await expectNoMarkers(laptop);
      expect(await laptop.read(MEETING)).toContain('typed by Mara Quill mid-sync');
      await expectVersionsSurvive(laptop, [studios]);
    },
    TIMEOUT,
  );

  it(
    'three Macs each adding a property converge on all three, with no copy',
    async () => {
      const { studio, laptop, base, env, trash, bare } = await twoMacs({ [MEETING]: BASE });
      const atticRoot = join(base, 'Attic', 'vault');
      await mkdir(join(base, 'Attic'), { recursive: true });
      await must(
        join(base, 'Attic'),
        ['clone', '--quiet', '--origin', 'origin', '--', bare, 'vault'],
        env,
      );
      const attic = macAt({ name: 'Attic', root: atticRoot, env, trash });
      await studio.write(MEETING, typeFile(ROOM));
      await laptop.write(MEETING, typeFile(TASKS));
      await attic.write(MEETING, typeFile(['  mood:', '    kind: text']));
      for (const mac of [studio, laptop, attic, studio, laptop]) {
        const report = await mac.sync();
        expect(report.conflicts, mac.name).toEqual([]);
      }
      for (const mac of [studio, laptop, attic]) {
        await expectNoMarkers(mac);
        expect((await entriesOf(mac)).sort(), mac.name).toEqual(['date', 'mood', 'room', 'tasks']);
      }
      expect(await attic.read(MEETING)).toBe(await studio.read(MEETING));
    },
    TIMEOUT,
  );

  it(
    'a settings file at a path with spaces, accents and a leading dash merges by keys',
    async () => {
      const path = '.atlas/types/-réunion d’équipe.md';
      const { laptop } = await bothChange(path, {
        base: BASE,
        studio: typeFile(ROOM),
        laptop: typeFile(TASKS),
      });
      const report = await laptop.sync();
      expect(report.conflicts).toEqual([]);
      await expectNoMarkers(laptop);
      expect(await entriesOf(laptop, path)).toEqual(['date', 'tasks', 'room']);
    },
    TIMEOUT,
  );

  it(
    'a settings file that is not UTF-8 is copied byte for byte, never merged as text',
    async () => {
      const latin1 = (text: string) => Buffer.from(text, 'latin1');
      const studios = latin1(typeFile(ROOM, { body: 'Caf\u00e9 meetings.' }));
      const laptops = latin1(typeFile(TASKS, { body: 'Caf\u00e9 meetings.' }));
      const { laptop } = await bothChange(MEETING, {
        base: latin1(typeFile([], { body: 'Caf\u00e9 meetings.' })),
        studio: studios,
        laptop: laptops,
      });
      const report = await laptop.sync();
      expect(report.conflicts.map((conflict) => conflict.path)).toEqual([MEETING]);
      await expectVersionsSurvive(laptop, [studios, laptops]);
    },
    TIMEOUT,
  );

  it(
    'a file with a byte-order mark merges with the mark kept, and no copy',
    async () => {
      const bom = '﻿';
      const { laptop } = await bothChange(MEETING, {
        base: bom + BASE,
        studio: bom + typeFile(ROOM),
        laptop: bom + typeFile(TASKS),
      });
      const report = await laptop.sync();
      expect(report.conflicts).toEqual([]);
      const merged = await laptop.read(MEETING);
      expect(merged.startsWith(bom)).toBe(true);
      expect(merged).toContain('  room:');
    },
    TIMEOUT,
  );
});
