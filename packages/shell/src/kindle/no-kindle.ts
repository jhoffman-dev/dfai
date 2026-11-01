import { NO_KINDLE_SYNC_RECORD } from '@dfai/domain';
import type { KindleHost } from './use-kindle-sync.ts';

/** Stands in where the host gave no Kindle: never reached, as nothing Kindle is offered then. */
const NOT_OFFERED = (): never => {
  throw new Error('Kindle is not offered here.');
};

/**
 * No Kindle (a window drawn without one, as the unit tests draw it): never
 * connected, so nothing syncs by itself, and no command or card is shown.
 */
export const NO_KINDLE: KindleHost = {
  notebook: { fetchLibrary: NOT_OFFERED, fetchAnnotations: NOT_OFFERED },
  session: { connect: NOT_OFFERED, disconnect: NOT_OFFERED },
  sync: NOT_OFFERED,
  delay: { wait: NOT_OFFERED },
  records: { read: () => NO_KINDLE_SYNC_RECORD, write: () => {} },
  vaults: { isOn: () => false, set: () => {} },
};
