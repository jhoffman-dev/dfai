import type { EntryPoint, EntryPointsOffered } from '@dfai/application';
import { SETTINGS_SECTIONS, type SettingsSectionLink } from '@dfai/ui';
import {
  globalCaptureSettings,
  googleCalendarSettingsCard,
  granolaSettingsCard,
  kindleSettingsCard,
  imageSettingsPanel,
  profileSettingsCard,
  quickAddSettingsCard,
  secretsSettingsCard,
  slackSettingsCard,
  syncSettingsCard,
} from '../pages-on-first-use.ts';

/*
 * The sections `app.tsx` hands to Settings, loaded on first use, under the
 * names it draws them by. They are drawn inside `SettingsPanel`'s `Suspense`.
 */
export const GlobalCaptureSettings = globalCaptureSettings.Component;
export const GoogleCalendarSettingsCard = googleCalendarSettingsCard.Component;
export const GranolaSettingsCard = granolaSettingsCard.Component;
export const KindleSettingsCard = kindleSettingsCard.Component;
export const ImageSettingsPanel = imageSettingsPanel.Component;
export const ProfileSettingsCard = profileSettingsCard.Component;
export const QuickAddSettingsCard = quickAddSettingsCard.Component;
export const SecretsSettingsCard = secretsSettingsCard.Component;
export const SlackSettingsCard = slackSettingsCard.Component;
export const SyncSettingsCard = syncSettingsCard.Component;

/** The sections the app draws after the dialog's own, by the name `SETTINGS_SECTIONS` gives each. */
export type AppSettingsSection =
  | 'profile'
  | 'index'
  | 'images'
  | 'globalCapture'
  | 'quickAdd'
  | 'secrets'
  | 'googleCalendar'
  | 'granola'
  | 'slack'
  | 'kindle'
  | 'claude'
  | 'sync'
  | 'notHere'
  | 'about';

/**
 * The app's sections in the order they are drawn and listed; `withVault`
 * ones only once a vault is open, one with an `entry` only where it is
 * offered (#657), and a `whenLimited` one only where the platform lacks
 * something (#670). The one table both the list on the left and the sections
 * themselves are drawn from, so the two cannot disagree.
 */
const ORDER: readonly {
  readonly key: AppSettingsSection;
  readonly withVault: boolean;
  readonly entry?: EntryPoint;
  readonly whenLimited?: true;
}[] = [
  { key: 'profile', withVault: true },
  { key: 'index', withVault: false },
  { key: 'images', withVault: false },
  { key: 'globalCapture', withVault: false, entry: 'globalCaptureSettings' },
  { key: 'quickAdd', withVault: true },
  { key: 'secrets', withVault: true, entry: 'secretsSettings' },
  { key: 'googleCalendar', withVault: true, entry: 'googleCalendarSettings' },
  { key: 'granola', withVault: true, entry: 'granolaSettings' },
  { key: 'slack', withVault: true, entry: 'slackSettings' },
  { key: 'kindle', withVault: true, entry: 'kindleSettings' },
  { key: 'claude', withVault: false, entry: 'claudeSettings' },
  { key: 'sync', withVault: true, entry: 'syncSettings' },
  { key: 'notHere', withVault: false, whenLimited: true },
  { key: 'about', withVault: false },
];

/** The sections shown, as the app draws them and as the dialog lists them. */
export interface SettingsSectionsShown {
  readonly keys: readonly AppSettingsSection[];
  readonly links: readonly SettingsSectionLink[];
}

interface SectionLists {
  readonly withVault: SettingsSectionsShown;
  readonly withoutVault: SettingsSectionsShown;
}

/** One platform's lists, as it lacks something or not. */
interface ListsByLimit {
  readonly limited: SectionLists;
  readonly complete: SectionLists;
}

/** Each platform's lists, made once: the window is handed one `offered` for its life. */
const listsFor = new WeakMap<EntryPointsOffered, ListsByLimit>();

function shownOf(keys: readonly AppSettingsSection[]): SettingsSectionsShown {
  return { keys, links: keys.map((key) => SETTINGS_SECTIONS[key]) };
}

function listsOf(offered: EntryPointsOffered, limited: boolean): SectionLists {
  const shown = ORDER.filter(
    (entry) =>
      (entry.entry === undefined || offered[entry.entry]) && (limited || !entry.whenLimited),
  );
  return {
    withVault: shownOf(shown.map((entry) => entry.key)),
    withoutVault: shownOf(shown.filter((entry) => !entry.withVault).map((entry) => entry.key)),
  };
}

function sectionLists(offered: EntryPointsOffered, limited: boolean): SectionLists {
  let made = listsFor.get(offered);
  if (made === undefined) {
    made = { limited: listsOf(offered, true), complete: listsOf(offered, false) };
    listsFor.set(offered, made);
  }
  return limited ? made.limited : made.complete;
}

/**
 * The app's sections: which to draw, in order, and their links for the
 * dialog's list on the left. Some are only drawn with a vault open: they want
 * its settings note, its Keychain entries or its repository, and some only
 * where the platform offers them; Not available here only where it lacks
 * something. Kept here rather than gathered from the
 * sections as they mount, so that opening Settings costs no extra commit;
 * e2e/settings-sections.spec.ts holds the list in step with what is drawn.
 * The same object each time for the same `offered`, so the dialog's list can
 * be memoised on it.
 */
export function settingsSectionsShown({
  vaultOpen,
  offered,
  limited = false,
}: {
  vaultOpen: boolean;
  offered: EntryPointsOffered;
  /** Whether the platform lacks anything the person would miss (#670). */
  limited?: boolean;
}): SettingsSectionsShown {
  const lists = sectionLists(offered, limited);
  return vaultOpen ? lists.withVault : lists.withoutVault;
}
