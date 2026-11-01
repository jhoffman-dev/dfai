import type { ComponentProps } from 'react';
import { LoadedLater } from '../page-frame-fallback.tsx';
import { activityScreen } from '../pages-on-first-use.ts';
import { localClock } from '../today.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';

const ActivityScreen = activityScreen.Component;

/**
 * What the Activity page needs from the window: the log's lines as
 * `useActivity` reads them. That hook stays the window's, since the same
 * read counts the sidebar's unseen errors, so the page draws with the window.
 */
export interface ActivityWiring {
  readonly activity: ComponentProps<typeof ActivityScreen>['activity'];
}

/** The Activity page as a tab (U-28, tab-model.md PR B). */
export function ActivityContainer({ wiring, chrome }: PageContainerProps) {
  const { pages } = wiring;
  return (
    <LoadedLater chrome={chrome}>
      <ActivityScreen
        activity={pages.activity.activity}
        clock={localClock}
        onOpenSubject={(subject) =>
          subject.kind === 'rule'
            ? pages.openPage({ kind: 'automations' })
            : pages.openNote(subject.path)
        }
        {...chrome}
      />
    </LoadedLater>
  );
}
