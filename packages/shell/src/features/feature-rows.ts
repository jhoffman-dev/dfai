import { featureById, FEATURES, featuresOn, type Feature, type FeatureId } from '@dfai/domain';
import type { FeatureRow } from '@dfai/ui';

/** Settings → Features' rows (#901): every key feature, on or off, and what holds one off. */
export function featureRows(off: readonly FeatureId[]): readonly FeatureRow[] {
  const on = featuresOn(off);
  return FEATURES.map((feature) => ({
    id: feature.id,
    label: feature.label,
    summary: feature.summary,
    on: on[feature.id],
    needs: neededOff(feature, on),
  }));
}

/** The label of the first feature `feature` requires that is off, or null when none is. */
function neededOff(feature: Feature, on: ReturnType<typeof featuresOn>): string | null {
  const off = feature.requires.find((id) => !on[id]);
  return off === undefined ? null : featureById(off).label;
}
