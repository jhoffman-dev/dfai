import { NAME_PLACEHOLDER } from '@dfai/domain';
import { ProfileSettings } from '@dfai/ui';
import type { ProfileSetting } from './use-profile-setting.ts';
import type { SelfEmailsSetting } from './use-self-emails-setting.ts';

/** Settings → Profile, wired to the vault's settings note. */
export function ProfileSettingsCard({
  setting,
  emails,
}: {
  setting: ProfileSetting;
  emails: SelfEmailsSetting;
}) {
  const { profile } = setting;
  const known = profile === 'unknown' ? null : profile;
  return (
    <ProfileSettings
      name={known?.name ?? ''}
      preferredName={known?.preferredName ?? ''}
      placeholder={NAME_PLACEHOLDER}
      problem={setting.problem ?? emails.problem}
      disabled={known === null}
      emails={emails.view}
      onName={(name) => setting.save({ name })}
      onPreferredName={(preferredName) => setting.save({ preferredName })}
      onSaveEmails={emails.save}
    />
  );
}
