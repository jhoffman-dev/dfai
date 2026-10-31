import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { filesOfShard, longestFirst, type Durations } from './unit-shards.ts';

/*
 * Vitest's sequencer for the CI shards (tools/ci/vitest.shard.config.ts): a
 * shard's files are dealt by duration (unit-shards.ts), and run slowest first,
 * so the longest file starts at once instead of last.
 */

const DURATIONS_FILE = new URL('./unit-durations.json', import.meta.url);

function recordedDurations(): Durations {
  const { files } = JSON.parse(readFileSync(DURATIONS_FILE, 'utf8')) as { files: Durations };
  return files;
}

export class DurationSequencer extends BaseSequencer {
  private readonly durations = recordedDurations();

  override shard(specs: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 };
    const byPath = new Map(specs.map((spec) => [this.pathOf(spec), spec]));
    const mine = filesOfShard([...byPath.keys()], this.durations, { index, count });
    return Promise.resolve(mine.map((path) => byPath.get(path)!));
  }

  override sort(specs: TestSpecification[]): Promise<TestSpecification[]> {
    const byPath = new Map(specs.map((spec) => [this.pathOf(spec), spec]));
    const order = longestFirst([...byPath.keys()], this.durations);
    return Promise.resolve(order.map((path) => byPath.get(path)!));
  }

  private pathOf(spec: TestSpecification): string {
    return relative(this.ctx.config.root, spec.moduleId).split('\\').join('/');
  }
}
