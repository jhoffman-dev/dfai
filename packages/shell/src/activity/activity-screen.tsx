import { withKindToggled, type ActivitySubject } from '@dfai/domain';
import type { Clock } from '@dfai/application';
import { ActivityPage, type PageHistory } from '@dfai/ui';
import { activityEntries, subjectOf } from './activity-rows.ts';
import type { useActivity } from './use-activity.ts';

/**
 * The Activity page as a page (U-28): the log's lines, as the filters and
 * search leave them, in place of the panes — as the Automations page is.
 */
export function ActivityScreen({
  activity,
  clock,
  onOpenSubject,
  onShowSidebar,
  history,
}: {
  activity: ReturnType<typeof useActivity>;
  clock: Pick<Clock, 'today'>;
  /** Opens the note, the rule or the source a line is about. */
  onOpenSubject: (subject: ActivitySubject) => void;
  onShowSidebar?: () => void;
  history?: PageHistory;
}) {
  const { shown, total, error, query, setQuery } = activity;
  return (
    <ActivityPage
      rows={shown === null ? null : activityEntries(shown, clock.today())}
      total={total}
      error={error}
      level={query.level}
      kinds={query.kinds}
      text={query.text}
      onLevel={(level) => setQuery({ ...query, level })}
      onToggleKind={(kind) => setQuery(withKindToggled(query, kind))}
      onText={(text) => setQuery({ ...query, text })}
      onOpenSubject={(id) => {
        const subject = shown === null ? null : subjectOf(shown, id);
        if (subject !== null) onOpenSubject(subject);
      }}
      {...(onShowSidebar !== undefined && { onShowSidebar })}
      {...(history !== undefined && { history })}
    />
  );
}
