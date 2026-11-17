import {
  FEATURES_OFF_KEY,
  featuresOffAfter,
  featuresOffAsWritten,
  parseFeaturesOff,
  type FeatureId,
} from '@dfai/domain';
import type { SettingsWriter } from '../settings/index.ts';

const NONE_OFF: readonly FeatureId[] = Object.freeze([]);

/** Each off list handed out, by its content: a read that says the same answers the same array. */
const lists = new Map<string, readonly FeatureId[]>();

/**
 * The features switched off in settings already read (#901): none when the
 * key is absent. In the vault rather than the browser, so both Macs and the
 * web show the same features. The same frozen array for the same content, so
 * a read of the note after any write to it rebuilds nothing that is drawn
 * from the list.
 */
export function featuresOffOf(settings: Readonly<Record<string, unknown>>): readonly FeatureId[] {
  const off = parseFeaturesOff(settings[FEATURES_OFF_KEY]);
  if (off.length === 0) return NONE_OFF;
  const key = off.join(' ');
  let known = lists.get(key);
  if (known === undefined) {
    known = Object.freeze([...off]);
    lists.set(key, known);
  }
  return known;
}

/**
 * Writes one feature's switch into the vault's settings, worked out from the
 * list as the file holds it at the writer's turn: two switches flipped quickly
 * each keep the other's change, an id only a newer version knows is kept as
 * written, and nothing else in the file is touched. A value that is not a
 * list (written by hand) is the one case where the key is rewritten whole: it
 * becomes a list holding only what was just chosen.
 */
export async function saveFeatureSwitch({
  settings,
  id,
  on,
}: {
  settings: SettingsWriter;
  id: FeatureId;
  on: boolean;
}): Promise<void> {
  await settings.update((current) => ({
    [FEATURES_OFF_KEY]: [
      ...featuresOffAfter(featuresOffAsWritten(current[FEATURES_OFF_KEY]), { id, on }),
    ],
  }));
}
