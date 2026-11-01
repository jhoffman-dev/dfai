import type { OwnWrites } from '@dfai/application';

/**
 * The same record of the app's own writes, also saying where each landed.
 * Every write through a vault's bound ports is kept here, made or failed, so
 * this hears of a template or a type the app wrote even though the watcher's
 * echo of it is left out (#254).
 */
export function tellingOwnWrites(
  ownWrites: OwnWrites,
  wrote: (write: { vault: string; path: string }) => void,
): OwnWrites {
  return {
    ...ownWrites,
    record(write) {
      ownWrites.record(write);
      wrote(write);
    },
    forget(file) {
      ownWrites.forget(file);
      wrote(file);
    },
  };
}
