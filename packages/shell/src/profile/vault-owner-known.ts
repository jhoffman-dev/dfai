import type { ProfileSetting } from './use-profile-setting.ts';
import type { SelfEmailsSetting } from './use-self-emails-setting.ts';

/**
 * Whether who the vault's owner is has been read: the profile's name from a
 * settings note that could be read, and the owner's addresses settled (#173).
 * A settings note found unreadable has answered, but said nothing, so the
 * owner is not known: nothing that asks who they are acts on the stand-in
 * (#226) — not the meeting import, the automations, nor the offered cleanup.
 * {@link settingsUnreadable} says so while it lasts.
 */
export function vaultOwnerKnown(
  profile: Pick<ProfileSetting, 'loaded' | 'settled'>,
  emails: Pick<SelfEmailsSetting, 'settled'>,
): boolean {
  return profile.settled && profile.loaded && emails.settled;
}

/**
 * Why the vault's settings note could not be read, while it could not:
 * what holds the meeting import and the automations ({@link vaultOwnerKnown}).
 * Null while it reads, and before it has answered at all.
 */
export function settingsUnreadable(
  profile: Pick<ProfileSetting, 'loaded' | 'settled' | 'problem'>,
): string | null {
  if (!profile.settled || profile.loaded) return null;
  return profile.problem ?? 'it could not be read';
}
