/**
 * The key features a person can switch off in Settings → Features (#901), so
 * that what they never use leaves the view. Switching one off deletes
 * nothing: its notes and files stay, and switching it on brings it back.
 */
export type FeatureId =
  'reading' | 'kindle' | 'ask' | 'automations' | 'meetings' | 'graph' | 'slack';

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
  {
    id: 'kindle',
    label: 'Kindle',
    summary: 'Kindle highlights synced into literature notes, every four hours and on asking.',
    requires: ['reading'],
  },
  {
    id: 'ask',
    label: 'Ask and Claude chat',
    summary: 'Ask questions of the vault, and chat with Claude beside your notes.',
    requires: [],
  },
  {
    id: 'automations',
    label: 'Automations',
    summary: 'Rules that file, archive and write notes on a schedule or as notes change.',
    // Not Meetings: most rules act on any note, and a meeting note made by hand is still one.
    requires: [],
  },
  {
    id: 'meetings',
    label: 'Meetings',
    summary: 'Meetings pulled from Granola and read from Google Calendar as notes.',
    requires: [],
  },
  {
    id: 'graph',
    label: 'Graph',
    summary: 'The map of how notes link to one another, for the vault or one note.',
    requires: [],
  },
  {
    id: 'slack',
    label: 'Slack capture',
    summary: 'A pasted Slack link offered for saving as a note, and its Settings.',
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

/**
 * The off list after one feature's switch is flipped: that id taken out, and
 * put back at the end when it is switched off. Every other entry is kept as
 * it stands, in its order, whatever it is and whether or not this version
 * knows it. A feature off only because what it requires is off is not in the
 * list, and no flip of another feature puts it there or takes it out.
 */
export function featuresOffAfter<Entry>(
  off: readonly Entry[],
  { id, on }: { readonly id: Entry; readonly on: boolean },
): readonly Entry[] {
  const others = off.filter((other) => other !== id);
  return on ? others : [...others, id];
}

/**
 * The off list as the settings file holds it, for a write to change one id
 * of: every entry as written, in its order — ids this version does not know,
 * and whatever a hand or a later version put there that is not an id — so a
 * flip here changes that one id and nothing else. What is not a list holds
 * no switch to keep: a write replaces it.
 */
export function featuresOffAsWritten(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) return [];
  const entries: readonly unknown[] = value;
  return [...entries];
}

/** The feature itself, by its id. */
export function featureById(id: FeatureId): Feature {
  const feature = FEATURES.find((candidate) => candidate.id === id);
  if (feature === undefined) throw new Error(`No feature is called ${id}.`);
  return feature;
}
