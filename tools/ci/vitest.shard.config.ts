import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import whole from '../../vitest.config.ts';
import { DurationSequencer } from './duration-sequencer.ts';

/*
 * The repository's Vitest config, for one shard of the suite in CI
 * (.github/workflows/gate.yml, the `unit` jobs): the same tests and the same
 * coverage, without the thresholds.
 *
 * A third of the tests covers a third of the code, so a shard held to the
 * thresholds always fails them. They are not dropped: the `coverage` job merges
 * the shards' reports under vitest.config.ts itself, thresholds and all.
 *
 * The files are dealt out by how long each took on CI, not by a hash of their
 * path, and each shard runs its slowest first (duration-sequencer.ts).
 */
const coverage = { ...whole.test?.coverage };
delete coverage.thresholds;

export default defineConfig({
  ...whole,
  // Vitest takes its root from the config file's folder, which is not this one's.
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    ...whole.test,
    coverage,
    sequence: { ...whole.test?.sequence, sequencer: DurationSequencer },
  },
});
