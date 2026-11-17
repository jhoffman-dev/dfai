import { FEATURES_OFF_KEY, featuresOffAfter, parseFeaturesOff, type FeatureId } from '@dfai/domain';
import type { SettingsWriter } from '../settings/index.ts';

/**
 * The features switched off in settings already read (#901): none when the
 * key is absent. In the vault rather than the browser, so both Macs and the
 * web show the same features.
 */
export function featuresOffOf(settings: Readonly<Record<string, unknown>>): readonly FeatureId[] {
  return parseFeaturesOff(settings[FEATURES_OFF_KEY]);
}

/**
 * Writes one feature's switch into the vault's settings, worked out from the
 * list as it stands at the writer's turn: two switches flipped quickly each
 * keep the other's change, and nothing else in the file is touched.
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
    [FEATURES_OFF_KEY]: [...featuresOffAfter(featuresOffOf(current), { id, on })],
  }));
}
