import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it, onTestFinished } from 'vitest';
import { isolatedWorld, must, TIMEOUT } from './two-macs.harness.ts';

/*
 * Issue #397: the harness never removed its world, and a night of runs left
 * 20,000 `atlas-two-macs-*` folders in the temp folder.
 */
describe('the two-Macs harness', () => {
  it('removes its world once the test has finished', async () => {
    let base = '';
    // Registered first, so it runs after the harness's own clean-up.
    onTestFinished(() => expect(existsSync(base)).toBe(false));
    ({ base } = await isolatedWorld());
    expect(existsSync(base)).toBe(true);
  });

  let failedBase = '';
  it.fails('removes its world when the test fails too', async () => {
    ({ base: failedBase } = await isolatedWorld());
    throw new Error('the test fails after making its world');
  });
  afterAll(() => {
    // Made, or the check below would pass with nothing to check.
    expect(failedBase).not.toBe('');
    expect(existsSync(failedBase)).toBe(false);
  });

  /*
   * Issue #477: git hands its housekeeping (`maintenance run --auto`, which runs
   * `gc --auto`) to a detached process, which went on writing into the world
   * while the clean-up removed it (ENOTEMPTY on `vault.git/info`).
   */
  it(
    'has finished all git work by the time a command it ran returns',
    async () => {
      const { base, env, home, bare } = await isolatedWorld();
      // The remote's housekeeping after a push must have work to do, whichever
      // strategy this git's `maintenance run --auto` uses: `gc` up to 2.53
      // (`gc.auto`), geometric since 2.54 (its own threshold, raised from 100 to
      // 6700 loose objects in 2.56, so it stopped running here: #606).
      await writeFile(
        join(home, '.gitconfig'),
        '[gc]\n\tauto = 1\n[maintenance "geometric-repack"]\n\tauto = -1\n' +
          '[receive]\n\tunpackLimit = 100000\n',
      );
      await must(base, ['init', '--quiet', '--bare', '--initial-branch=main', bare], env);
      const clone = join(base, 'Studio');
      await must(base, ['init', '--quiet', '--initial-branch=main', clone], env);
      for (let n = 0; n < 1500; n += 1) await writeFile(join(clone, `f${n}.md`), `${n}\n`);
      await must(clone, ['add', '--all'], env);
      const who = ['-c', 'user.name=Seed', '-c', 'user.email=seed@x'];
      await must(clone, [...who, 'commit', '--quiet', '-m', 'seed'], env);
      await must(clone, ['push', '--quiet', bare, 'HEAD:main'], env);
      // Both strategies' repack writes `info/refs` in a bare repository; gc holds
      // `gc.pid` while it runs, and maintenance `objects/maintenance.lock`.
      expect(existsSync(join(bare, 'gc.pid'))).toBe(false);
      expect(existsSync(join(bare, 'objects', 'maintenance.lock'))).toBe(false);
      expect(existsSync(join(bare, 'info', 'refs'))).toBe(true);
    },
    TIMEOUT,
  );
});
