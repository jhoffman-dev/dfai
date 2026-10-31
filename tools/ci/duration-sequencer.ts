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
    const byPath = this.byPath(specs);
    const mine = filesOfShard([...byPath.keys()], this.durations, { index, count });
    return Promise.resolve(mine.flatMap((path) => byPath.get(path)!));
  }

  override sort(specs: TestSpecification[]): Promise<TestSpecification[]> {
    const byPath = this.byPath(specs);
    const order = longestFirst([...byPath.keys()], this.durations);
    return Promise.resolve(order.flatMap((path) => byPath.get(path)!));
  }

  /** The specs by file: a file in two projects is two specs, dealt to one shard together. */
  private byPath(specs: readonly TestSpecification[]): Map<string, TestSpecification[]> {
    const byPath = new Map<string, TestSpecification[]>();
    for (const spec of specs) {
      const path = this.pathOf(spec);
      byPath.set(path, [...(byPath.get(path) ?? []), spec]);
    }
    return byPath;
  }

  private pathOf(spec: TestSpecification): string {
    return relative(this.ctx.config.root, spec.moduleId).split('\\').join('/');
  }
}
