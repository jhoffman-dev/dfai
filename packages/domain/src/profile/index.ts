export {
  changeProfile,
  cleanProfileName,
  EMPTY_PROFILE,
  hasFullName,
  NAME_PLACEHOLDER,
  parseProfile,
  PROFILE_NAME_KEY,
  PROFILE_NAME_LIMIT,
  PROFILE_PREFERRED_NAME_KEY,
  profileSettingsChanges,
} from './profile.ts';
export type { Profile, ProfileChange, ProfileState } from './profile.ts';
export {
  GRANOLA_SELF_EMAILS_KEY,
  parseSelfEmails,
  SELF_EMAILS_KEY,
  selfEmailsFromText,
  selfEmailsSettingsChanges,
} from './self-emails.ts';
export type { SelfEmails, SelfEmailsReading, SelfEmailsSource } from './self-emails.ts';
