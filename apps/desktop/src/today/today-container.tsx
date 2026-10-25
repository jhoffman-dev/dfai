import { useState } from 'react';
import { REVIEW_SCOPE, todayScope, type ReadScope } from '@dfai/application';
import { TodayMeetings, TodayPage } from '@dfai/ui';
import { useScopedIndexKey } from '../reads/use-scoped-index-key.ts';
import { localClock } from '../today.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import { useToday } from './use-today.ts';
import { useTodaysMeetings } from './use-todays-meetings.ts';

/** What the Today page needs from the window beyond what every page is handed. */
export interface TodayWiring {
  /** The saved view titled Today, which the page links to, when the vault has one. */
  readonly view: { readonly title: string; readonly onOpen: () => void } | null;
  readonly onOpenDailyNote: () => void;
}

/**
 * The Today page as a tab (#111, tab-model.md PR B): it reads the day's
 * tasks itself, so a tick or a read landing draws this and not the window.
 * Drawn only while it is the shown tab, and read afresh each time it is;
 * what is settling, and the last change's undo, are the window's per vault
 * (`pages.holds`), so a tab switched back to sees the tick still landing.
 */
export function TodayContainer({ wiring, chrome }: PageContainerProps) {
  const { pages, pane } = wiring;
  // Read again for news of the tasks, the projects and the Inbox alone: a
  // note saved elsewhere does not draw the page (#325). And of the notes the
  // tasks last read are filed under, whatever their type, or link by (#392).
  const [scope, setScope] = useState<ReadScope>(REVIEW_SCOPE);
  const indexKey = useScopedIndexKey({
    status: pane.indexStatus,
    vault: pane.vault,
    reader: ['today'],
    scope,
  });
  const today = useToday({
    ports: pages.ports,
    editors: pane.editors,
    clock: localClock,
    types: pane.types,
    vaultKey: pane.vault,
    indexKey,
    indexReady: pages.indexReady,
    open: true,
    onSettled: pages.onSettled,
    activity: pane.activity,
    held: pages.holds.today,
    toasts: pane.toasts,
  });
  const meetings = useTodaysMeetings({
    fs: pages.ports.fs,
    markdown: pages.ports.markdown,
    index: pages.ports.index,
    vault: pane.vault,
    day: today.page.today?.today ?? null,
    indexReady: pages.indexReady,
  });
  // Set while drawing, as React has a value from the last draw kept: the page
  // is drawn once again before anything is shown, with no commit between.
  const read = todayScope(today.page.today);
  if (namesOf(read) !== namesOf(scope)) setScope(read);
  return (
    <TodayPage
      {...today.page}
      view={pages.today.view}
      onOpen={pages.openNote}
      onOpenInbox={() => pages.openPage({ kind: 'inbox' })}
      onOpenReview={() => pages.openPage({ kind: 'review' })}
      onOpenDailyNote={pages.today.onOpenDailyNote}
      {...(meetings.length > 0 && {
        meetings: <TodayMeetings meetings={meetings} onOpen={pages.openNote} />,
      })}
      {...chrome}
    />
  );
}

/** The notes and the link names a scope adds to the review's, as one text to compare. */
const namesOf = (scope: ReadScope) =>
  [...(scope.notes ?? []), '', ...(scope.linkedNames ?? [])].join('\n');
