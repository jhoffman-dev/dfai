import type { WindowClosingPort } from '@dfai/application';

/**
 * The window's close, in three stages: every `writes` task, then every
 * `first` one, then every `last` one. A close waits for one handler; two
 * handlers registered apart would each close the window when theirs settled,
 * cutting the other short. Writes still under way — the Inbox's answers —
 * land before the last sync, or it carries the vault without them; and the
 * last sync must run before the Activity log's final write, or its line is lost.
 */
export function closingInStages(port: WindowClosingPort): {
  writes: WindowClosingPort;
  first: WindowClosingPort;
  last: WindowClosingPort;
} {
  const writes = new Set<() => Promise<void>>();
  const first = new Set<() => Promise<void>>();
  const last = new Set<() => Promise<void>>();
  let registered: Promise<unknown> | null = null;
  const runAll = async (tasks: ReadonlySet<() => Promise<void>>) => {
    // One stage's task failing must not keep the others from running.
    await Promise.allSettled([...tasks].map((task) => task()));
  };
  const stage =
    (tasks: Set<() => Promise<void>>): WindowClosingPort['beforeClose'] =>
    async (task) => {
      registered ??= port.beforeClose(async () => {
        await runAll(writes);
        await runAll(first);
        await runAll(last);
      });
      await registered;
      tasks.add(task);
      return () => void tasks.delete(task);
    };
  return {
    writes: { beforeClose: stage(writes) },
    first: { beforeClose: stage(first) },
    last: { beforeClose: stage(last) },
  };
}
