import type { NavigationPlace } from '../panes/navigation-history.ts';

/**
 * The key features a person can switch off in Settings → Features (#901), so
 * that what they never use leaves the view. Switching one off deletes
 * nothing: its notes and files stay, and switching it on brings it back.
 */
export type FeatureId = 'reading';

/** One key feature: what Settings calls it, the line saying what it is, and what it cannot work without. */
export interface Feature<Id extends string = FeatureId> {
  readonly id: Id;
  readonly label: string;
  readonly summary: string;
  /** Features this one needs: it is off whenever one of them is. Each is listed before it. */
  readonly requires: readonly Id[];
}

/** Every key feature, in the order Settings lists them. */
export const FEATURES: readonly Feature[] = [
  {
    id: 'reading',
    label: 'Reading',
    summary: 'PDFs and EPUBs in the reader, the Library and All highlights.',
    requires: [],
  },
];

/** The settings key listing the features switched off: absent, every feature is on. */
export const FEATURES_OFF_KEY = 'featuresOff';

/** Whether each feature is on. Every one is named, so none is forgotten. */
export type FeaturesOn<Id extends string = FeatureId> = Readonly<Record<Id, boolean>>;

const FEATURE_IDS: ReadonlySet<string> = new Set(FEATURES.map((feature) => feature.id));

export function isFeatureId(value: unknown): value is FeatureId {
  return typeof value === 'string' && FEATURE_IDS.has(value);
}

/**
 * The features a vault's settings switch off. A hand-edited file can hold
 * anything: what is not a list switches nothing off, an id that names no
 * feature (one from a later version, or a typo) is ignored, and a repeat
 * counts once. Storing what is off means a feature added later arrives on.
 */
export function parseFeaturesOff(value: unknown): readonly FeatureId[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isFeatureId))];
}

/** Whether each feature is on, given those switched off: one is off too when something it requires is. */
export function featuresOn(off: readonly FeatureId[]): FeaturesOn;
/** As above, among `features` rather than DFAI's own: how `requires` is held to its rule in tests. */
export function featuresOn<Id extends string>(
  off: readonly Id[],
  features: readonly Feature<Id>[],
): FeaturesOn<Id>;
export function featuresOn(
  off: readonly string[],
  features: readonly Feature<string>[] = FEATURES,
): FeaturesOn<string> {
  const on: Record<string, boolean> = {};
  // Each feature's requirements are listed before it, so they are decided first.
  for (const feature of features) {
    on[feature.id] = !off.includes(feature.id) && feature.requires.every((id) => on[id] === true);
  }
  return Object.freeze(on);
}

/** Every feature on, as a vault that never switched one off has them. */
export const EVERY_FEATURE_ON: FeaturesOn = featuresOn([]);

/** The off list after a feature's switch is flipped: kept in the order the features were switched off. */
export function featuresOffAfter(
  off: readonly FeatureId[],
  { id, on }: { readonly id: FeatureId; readonly on: boolean },
): readonly FeatureId[] {
  const others = off.filter((other) => other !== id);
  return on ? others : [...others, id];
}

/** The feature whose page a place is, or null when it belongs to none that can be switched off. */
export function featureOfPlace(place: NavigationPlace): FeatureId | null {
  switch (place.kind) {
    case 'library':
    case 'highlights':
    case 'document':
      return 'reading';
    default:
      return null;
  }
}

/** The feature itself, by its id. */
export function featureById(id: FeatureId): Feature {
  const feature = FEATURES.find((candidate) => candidate.id === id);
  if (feature === undefined) throw new Error(`No feature is called ${id}.`);
  return feature;
}
