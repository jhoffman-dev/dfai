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

/** The app's sections in the order `app.tsx` draws them; `withVault` ones only once a vault is open. */
const ORDER: readonly { readonly section: SettingsSectionLink; readonly withVault: boolean }[] = [
  { section: SETTINGS_SECTIONS.profile, withVault: true },
  { section: SETTINGS_SECTIONS.index, withVault: false },
  { section: SETTINGS_SECTIONS.images, withVault: false },
  { section: SETTINGS_SECTIONS.globalCapture, withVault: false },
  { section: SETTINGS_SECTIONS.quickAdd, withVault: true },
  { section: SETTINGS_SECTIONS.secrets, withVault: true },
  { section: SETTINGS_SECTIONS.googleCalendar, withVault: true },
  { section: SETTINGS_SECTIONS.granola, withVault: true },
  { section: SETTINGS_SECTIONS.slack, withVault: true },
  { section: SETTINGS_SECTIONS.kindle, withVault: true },
  { section: SETTINGS_SECTIONS.claude, withVault: false },
  { section: SETTINGS_SECTIONS.sync, withVault: true },
  { section: SETTINGS_SECTIONS.about, withVault: false },
];

const WITH_VAULT: readonly SettingsSectionLink[] = ORDER.map((entry) => entry.section);
const WITHOUT_VAULT: readonly SettingsSectionLink[] = ORDER.filter((entry) => !entry.withVault).map(
  (entry) => entry.section,
);

/**
 * The app's sections, for the dialog's list on the left. Some are only drawn
 * with a vault open: they want its settings note, its Keychain entries or its
 * repository. Kept here rather than gathered from the sections as they
 * mount, so that opening Settings costs no extra commit;
 * e2e/settings-sections.spec.ts holds this list and `app.tsx` in step. The
 * same array each time, so the dialog's list of them can be memoised on it.
 */
export function settingsSectionLinks({
  vaultOpen,
}: {
  vaultOpen: boolean;
}): readonly SettingsSectionLink[] {
  return vaultOpen ? WITH_VAULT : WITHOUT_VAULT;
}
