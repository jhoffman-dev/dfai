import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import { expectNoMarkers, expectVersionsSurvive, TIMEOUT, twoMacs } from './two-macs.harness.ts';
import { webWriter, type WebWriter } from './web-writer.test-support.ts';

/*
 * Attack on PR #745 (#665): the web as a third writer, against a delete and
 * against both Macs editing at once. Every typed version must survive
 * somewhere, and a delete must never silently win over an edit.
 */
const NOTE = 'Projects/Plan.md';
const BASE = '# Plan\n\nThe first draft.\n';
const FROM_STUDIO = '# Plan\n\nTyped on the Studio.\n';
const FROM_LAPTOP = '# Plan\n\nTyped on the Laptop.\n';
const FROM_WEB = '# Plan\n\nTyped on the iPad.\n';

async function world() {
  const made = await twoMacs({ [NOTE]: BASE, 'Projects/Other.md': 'other\n' });
  const scratch = join(made.base, 'web-scratch');
  await mkdir(scratch);
  const web = webWriter({ bare: made.bare, env: made.env, scratch });
  return { ...made, web };
}

async function onTheBranch(web: WebWriter): Promise<string[]> {
  const texts: string[] = [];
  for (const path of await web.github.paths()) texts.push((await web.github.textAt(path)) ?? '');
  return texts;
}

describe('attack #745: the web writer against deletes and a three-way edit', () => {
  it(
    'three-way: web, Studio and Laptop all edit one note between syncs, and all three survive everywhere',
    async () => {
      const { studio, laptop, web } = await world();
      const opened = await web.open(NOTE);
      await studio.write(NOTE, FROM_STUDIO);
      await laptop.write(NOTE, FROM_LAPTOP);
      await studio.sync();
      expect((await web.save(opened, FROM_WEB)).kind).toBe('kept-as-copy');
      await laptop.sync();
      await studio.sync();
      await laptop.sync();
      for (const mac of [studio, laptop]) {
        await expectNoMarkers(mac);
        await expectVersionsSurvive(mac, [FROM_STUDIO, FROM_LAPTOP, FROM_WEB]);
      }
      const branch = await onTheBranch(web);
      for (const version of [FROM_STUDIO, FROM_LAPTOP, FROM_WEB]) expect(branch).toContain(version);
    },
    TIMEOUT,
  );

  it(
    'web delete vs desktop edit: the Studio’s edit survives on both Macs and the branch',
    async () => {
      const { studio, laptop, web } = await world();
      await web.fs.trashEntry({ path: createVaultPath(NOTE) });
      await studio.write(NOTE, FROM_STUDIO);
      await studio.sync();
      await laptop.sync();
      for (const mac of [studio, laptop]) {
        await expectNoMarkers(mac);
        await expectVersionsSurvive(mac, [FROM_STUDIO]);
      }
      expect(await onTheBranch(web)).toContain(FROM_STUDIO);
    },
    TIMEOUT,
  );

  it(
    'desktop delete vs web edit: the web’s typing survives somewhere, the delete does not silently win',
    async () => {
      const { studio, laptop, web } = await world();
      const opened = await web.open(NOTE);
      await studio.remove(NOTE);
      await studio.sync();

      // Observed: refused with "no such entry", which is not a stale refusal,
      // so no copy is offered, and even keepRefusedAsCopy would throw reading
      // the note that is gone. The web's typing exists only on screen.
      await web.save(opened, FROM_WEB);

      expect(await onTheBranch(web)).toContain(FROM_WEB);
      await laptop.sync();
      await expectVersionsSurvive(laptop, [FROM_WEB]);
    },
    TIMEOUT,
  );
});
