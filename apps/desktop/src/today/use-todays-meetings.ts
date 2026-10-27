import { useEffect, useMemo, useReducer } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  meetingsHeading,
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

/** How often the calendar's day is looked at again: its midnight is not the Mac's. */
const DAY_CHECK_MS = 60_000;

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

/** Today's meetings as the page draws them, under the heading that says whose day they are. */
export interface TodaysMeetings {
  readonly meetings: readonly TodayMeetingRow[];
  /** `Meetings`, or `Meetings · Tue 27 Oct, Chicago time` when they are another clock's day. */
  readonly heading: string;
}

/**
 * The calendar's day (#587), looked at again each minute while the vault
 * keeps a plan zone: at that zone's midnight the meetings turn to its new
 * day, though the page's own day, the Mac's, has not. Drawn again only
 * when the day it reads has changed.
 */
function useMeetingsDay({
  day,
  planZone,
  clock,
}: {
  day: string | null;
  planZone: string | null;
  clock: Pick<Clock, 'now'>;
}): string | null {
  const [, turn] = useReducer((count: number) => count + 1, 0);
  const meetingsDay = day === null ? null : meetingsDayOf({ pageDay: day, planZone, clock });
  useEffect(() => {
    if (day === null || planZone === null) return;
    const timer = setInterval(() => {
      if (meetingsDayOf({ pageDay: day, planZone, clock }) !== meetingsDay) turn();
    }, DAY_CHECK_MS);
    return () => clearInterval(timer);
  }, [day, planZone, clock, meetingsDay]);
  return meetingsDay;
}

/**
 * Today's meetings for the Today page (ADR-0046), read from the event notes
 * and kept (ADR-0040) until the index has news of them. Only for a vault
 * that reads its meetings: any other is asked nothing. The day is the
 * calendar's, on the plan zone the vault keeps (#587), as the morning brief's
 * is; when that is not the Mac's zone, the heading says which day and clock.
 */
export function useTodaysMeetings({
  fs,
  markdown,
  index,
  vault,
  day,
  clock,
  macZone,
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
  /** The zone the Mac keeps time in; left out, the heading never names a clock. */
  macZone?: string;
  indexReady: boolean;
}): TodaysMeetings {
  const { settings } = useVaultSettingsRead({ fs, markdown, vaultKey: vault });
  const enabled = parseMeetingSetting(settings ?? {}).enabled;
  const planZone = storedPlanZone(settings ?? {});
  const meetingsDay = useMeetingsDay({ day, planZone, clock });
  const { data } = useQuery({
    queryKey: scopedReadKey(vault ?? '', 'day-meetings', meetingsDay),
    queryFn: () => readDayMeetings({ index, day: meetingsDay ?? '' }),
    meta: scopedReadMeta(DAY_MEETINGS_SCOPE),
    enabled: vault !== null && meetingsDay !== null && enabled && indexReady,
  });
  const meetings = useMemo(
    () => (data === undefined || !enabled ? NONE : data.map(todayMeetingRow)),
    [data, enabled],
  );
  const heading =
    meetingsDay === null || macZone === undefined
      ? 'Meetings'
      : meetingsHeading({ day: meetingsDay, planZone, macZone });
  return useMemo(() => ({ meetings, heading }), [meetings, heading]);
}
