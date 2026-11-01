import { kindleAutoSyncHeldUntil, type KindleSyncRecord } from '@dfai/domain';
import type { KindleBusy, KindleView } from '@dfai/ui';

/** A time as this Mac's clock shows it: the day, and the time to the minute. */
const kindleTime = (at: number): string =>
  new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** Settings → Kindle's view of the record, and what is under way. */
export function kindleViewOf(
  record: KindleSyncRecord,
  state: { busy: KindleBusy | null; problem: string | null; intoVault: boolean; now: number },
): KindleView {
  const heldUntil = kindleAutoSyncHeldUntil(record.lastHoldAt);
  return {
    connected: record.connected,
    intoVault: state.intoVault,
    busy: state.busy,
    last: record.last === null ? null : { ...record.last, at: kindleTime(record.last.at) },
    heldUntil: heldUntil !== null && heldUntil > state.now ? kindleTime(heldUntil) : null,
    problem: state.problem,
  };
}
