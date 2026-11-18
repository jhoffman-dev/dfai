import { offeredWithFeatures, type EntryPointsOffered } from '@dfai/application';
import { featuresOn, type FeatureId } from '@dfai/domain';

/** Each platform's answers, by the off list's content: the same list always gets the same object. */
const made = new WeakMap<EntryPointsOffered, Map<string, EntryPointsOffered>>();

/**
 * What the window offers with the features in `off` switched off (#901): the
 * platform's own `offered` while nothing is, and otherwise one object for each
 * off list, whatever array it came in. What is memoised on `offered` — the
 * Settings sections, the export formats, the presets — is then made again only
 * when what is switched off changes, and only once for each list.
 */
export function offeredFor(
  platform: EntryPointsOffered,
  off: readonly FeatureId[],
): EntryPointsOffered {
  if (off.length === 0) return platform;
  const key = [...new Set(off)].sort().join(' ');
  let byList = made.get(platform);
  if (byList === undefined) {
    byList = new Map();
    made.set(platform, byList);
  }
  let offered = byList.get(key);
  if (offered === undefined) {
    offered = offeredWithFeatures(platform, featuresOn(off));
    byList.set(key, offered);
  }
  return offered;
}
