import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  parseMeetingSetting,
  storedPlanZone,
  vaultPathName,
  type DayMeeting,
  type VaultPath,
} from '@dfai/domain';
import {
  meetingsDayOf,
  readDayMeetings,
  DAY_MEETINGS_SCOPE,
  type Clock,
  type IndexPort,
  type MarkdownPort,
  type VaultFsPort,
} from '@dfai/application';
import type { TodayMeetingRow } from '@dfai/ui';
import { scopedReadKey, scopedReadMeta } from '../reads/query-client.ts';
import { useVaultSettingsRead } from '../settings/use-vault-settings-read.ts';

const NONE: readonly TodayMeetingRow[] = [];

/** A person's name as their note is called: its file name without `.md`. */
const nameOf = (path: VaultPath) => vaultPathName(path).replace(/\.md$/i, '');

/** A meeting as the Today page draws it. */
export function todayMeetingRow(meeting: DayMeeting): TodayMeetingRow {
  return {
    path: meeting.path,
    title: meeting.title,
    time: meeting.end === null ? meeting.start : `${meeting.start}–${meeting.end}`,
    people: meeting.people.map(nameOf),
    unanswered: meeting.unanswered,
  };
}

/**
 * Today's meetings for the Today page (ADR-0046), read from the event notes
 * and kept (ADR-0040) until the index has news of them. Only for a vault
 * that reads its meetings: any other is asked nothing. The day is the
 * calendar's, on the plan zone the vault keeps (#587), as the morning brief's is.
 */
export function useTodaysMeetings({
  fs,
  markdown,
  index,
  vault,
  day,
  clock,
  indexReady,
}: {
  fs: Pick<VaultFsPort, 'readNotes'>;
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>;
  index: Pick<IndexPort, 'query'>;
  vault: string | null;
  /** Today, `YYYY-MM-DD`, as the page reads it; null until it has. */
  day: string | null;
  /** The instant the calendar's day is read at. */
  clock: Pick<Clock, 'now'>;
  indexReady: boolean;
}): readonly TodayMeetingRow[] {
  const { settings } = useVaultSettingsRead({ fs, markdown, vaultKey: vault });
  const enabled = parseMeetingSetting(settings ?? {}).enabled;
  const planZone = storedPlanZone(settings ?? {});
  const meetingsDay = day === null ? null : meetingsDayOf({ pageDay: day, planZone, clock });
  const { data } = useQuery({
    queryKey: scopedReadKey(vault ?? '', 'day-meetings', meetingsDay),
    queryFn: () => readDayMeetings({ index, day: meetingsDay ?? '' }),
    meta: scopedReadMeta(DAY_MEETINGS_SCOPE),
    enabled: vault !== null && meetingsDay !== null && enabled && indexReady,
  });
  return useMemo(
    () => (data === undefined || !enabled ? NONE : data.map(todayMeetingRow)),
    [data, enabled],
  );
}
