import { EVERY_ENTRY_POINT, type EntryPoint, type EntryPointsOffered } from '@dfai/application';
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

/**
 * The app's sections in the order `app.tsx` draws them; `withVault` ones only
 * once a vault is open, and a section with an `entry` only where it is offered (#657).
 */
const ORDER: readonly {
  readonly section: SettingsSectionLink;
  readonly withVault: boolean;
  readonly entry?: EntryPoint;
}[] = [
  { section: SETTINGS_SECTIONS.profile, withVault: true },
  { section: SETTINGS_SECTIONS.index, withVault: false },
  { section: SETTINGS_SECTIONS.images, withVault: false },
  { section: SETTINGS_SECTIONS.globalCapture, withVault: false, entry: 'globalCaptureSettings' },
  { section: SETTINGS_SECTIONS.quickAdd, withVault: true },
  { section: SETTINGS_SECTIONS.secrets, withVault: true, entry: 'secretsSettings' },
  { section: SETTINGS_SECTIONS.googleCalendar, withVault: true, entry: 'googleCalendarSettings' },
  { section: SETTINGS_SECTIONS.granola, withVault: true, entry: 'granolaSettings' },
  { section: SETTINGS_SECTIONS.slack, withVault: true, entry: 'slackSettings' },
  { section: SETTINGS_SECTIONS.kindle, withVault: true, entry: 'kindleSettings' },
  { section: SETTINGS_SECTIONS.claude, withVault: false, entry: 'claudeSettings' },
  { section: SETTINGS_SECTIONS.sync, withVault: true, entry: 'syncSettings' },
  { section: SETTINGS_SECTIONS.about, withVault: false },
];

interface SectionLists {
  readonly withVault: readonly SettingsSectionLink[];
  readonly withoutVault: readonly SettingsSectionLink[];
}

/** Each platform's lists, made once: the window is handed one `offered` for its life. */
const listsFor = new WeakMap<EntryPointsOffered, SectionLists>();

function sectionLists(offered: EntryPointsOffered): SectionLists {
  const made = listsFor.get(offered);
  if (made !== undefined) return made;
  const shown = ORDER.filter((entry) => entry.entry === undefined || offered[entry.entry]);
  const lists = {
    withVault: shown.map((entry) => entry.section),
    withoutVault: shown.filter((entry) => !entry.withVault).map((entry) => entry.section),
  };
  listsFor.set(offered, lists);
  return lists;
}

/**
 * The app's sections, for the dialog's list on the left. Some are only drawn
 * with a vault open: they want its settings note, its Keychain entries or its
 * repository, and some only where the platform offers them. Kept here rather
 * than gathered from the sections as they mount, so that opening Settings
 * costs no extra commit; e2e/settings-sections.spec.ts holds this list and
 * `app.tsx` in step. The same array each time for the same `offered`, so the
 * dialog's list of them can be memoised on it.
 */
export function settingsSectionLinks({
  vaultOpen,
  offered = EVERY_ENTRY_POINT,
}: {
  vaultOpen: boolean;
  offered?: EntryPointsOffered;
}): readonly SettingsSectionLink[] {
  const lists = sectionLists(offered);
  return vaultOpen ? lists.withVault : lists.withoutVault;
}
