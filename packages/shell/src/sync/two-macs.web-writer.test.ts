import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  expectNoMarkers,
  expectVersionsSurvive,
  must,
  TIMEOUT,
  twoMacs,
  type Mac,
} from './two-macs.harness.ts';
import { webWriter, type WebWriter } from './web-writer.test-support.ts';

/*
 * #665: her MacBook syncs the vault by git and her iPad writes it through the
 * GitHub API. When both change one note before they meet, every version that
 * was typed ends up in the note or in a conflict copy beside it — on both
 * Macs and on the branch the web reads.
 */
const NOTE = 'Projects/Plan.md';
const BASE = '# Plan\n\nThe first draft.\n';
const FROM_STUDIO = '# Plan\n\nTyped on the Studio.\n';
const FROM_WEB = '# Plan\n\nTyped on the iPad.\n';
const WEB_COPY = 'Projects/Plan (conflict from DFAI web).md';

async function world() {
  const made = await twoMacs({ [NOTE]: BASE });
  const scratch = join(made.base, 'web-scratch');
  await mkdir(scratch);
  const web = webWriter({ bare: made.bare, env: made.env, scratch });
  return { ...made, web };
}

/** Every file's text on the branch the web reads. */
async function onTheBranch(web: WebWriter): Promise<string[]> {
  const texts: string[] = [];
  for (const path of await web.github.paths()) texts.push((await web.github.textAt(path)) ?? '');
  return texts;
}

/** Both Macs sync until they and the branch agree, then every version is checked everywhere. */
async function expectNothingLost({
  studio,
  laptop,
  web,
}: {
  studio: Mac;
  laptop: Mac;
  web: WebWriter;
}): Promise<void> {
  await studio.sync();
  await laptop.sync();
  await studio.sync();
  for (const mac of [studio, laptop]) {
    await expectNoMarkers(mac);
    await expectVersionsSurvive(mac, [FROM_STUDIO, FROM_WEB]);
  }
  const branch = await onTheBranch(web);
  for (const version of [FROM_STUDIO, FROM_WEB])
    expect(branch, 'a file on the branch holding the version').toContain(version);
}

describe('the web as a third writer of the two Macs’ vault (#665)', () => {
  it(
    'web then desktop: the Studio takes the web’s commit as a remote change and keeps both',
    async () => {
      const { studio, laptop, web } = await world();
      const opened = await web.open(NOTE);
      expect(await web.save(opened, FROM_WEB)).toEqual({ kind: 'saved' });
      await studio.write(NOTE, FROM_STUDIO);

      const report = await studio.sync();

      expect(await studio.read(NOTE)).toBe(FROM_STUDIO);
      // Named for the web, as the web names its own copies.
      expect(report.conflicts).toEqual([{ path: NOTE, copy: WEB_COPY, whose: 'theirs' }]);
      expect(await studio.read(WEB_COPY)).toBe(FROM_WEB);
      await expectNothingLost({ studio, laptop, web });
    },
    TIMEOUT,
  );

  it(
    'desktop then web: the web’s save is refused, and kept as a conflict copy beside the newer note',
    async () => {
      const { studio, laptop, web } = await world();
      const opened = await web.open(NOTE);
      await studio.write(NOTE, FROM_STUDIO);
      await studio.sync();

      const saved = await web.save(opened, FROM_WEB);

      expect(saved).toEqual({ kind: 'kept-as-copy', copy: WEB_COPY });
      expect(await web.github.textAt(NOTE)).toBe(FROM_STUDIO);
      expect(await web.github.textAt(WEB_COPY)).toBe(FROM_WEB);
      await expectNothingLost({ studio, laptop, web });
    },
    TIMEOUT,
  );

  it(
    'both at once: whichever lands first, neither version is lost',
    async () => {
      const { studio, laptop, web } = await world();
      const opened = await web.open(NOTE);
      await studio.write(NOTE, FROM_STUDIO);

      const [saved, synced] = await Promise.allSettled([web.save(opened, FROM_WEB), studio.sync()]);

      expect(saved.status === 'fulfilled' && saved.value.kind).toMatch(/^(saved|kept-as-copy)$/);
      // The web's commit can land between the Studio's fetch and its push: git
      // refuses that push as not a fast-forward, nothing is written over, and
      // the next sync merges it.
      if (synced.status === 'rejected') expect(String(synced.reason)).toMatch(/could not push/);
      await expectNothingLost({ studio, laptop, web });
    },
    TIMEOUT,
  );

  it(
    'records each web commit as the web’s, beside the Macs’ own',
    async () => {
      const { studio, web, bare, env } = await world();
      const opened = await web.open(NOTE);
      await web.save(opened, FROM_WEB);
      await studio.write(NOTE, FROM_STUDIO);
      await studio.sync();

      const authors = (await must(bare, ['log', '--format=%an', 'main'], env)).trim().split('\n');
      expect(authors).toContain('DFAI web');
      expect(authors).toContain('DFAI on Studio');
    },
    TIMEOUT,
  );
});
