import { useMemo, useState } from 'react';
import type { AutomationListing } from '@dfai/application';
import { lastUndoableRun, logEntrySummary, type LogEntry } from '@dfai/domain';
import { PastRunsUndo, type UndoableRun } from '@dfai/ui';
import { FeatureOffPage } from '../features/feature-off-page.tsx';
import type { PageChrome } from '../page-frame-fallback.tsx';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import { shownTime } from './automation-rows.ts';
import { useAutomationsController, type AutomationsController } from './automations-store.ts';

const NO_RUNS: readonly UndoableRun[] = [];

/** Each rule whose last run can be undone, with when that run was and what it did. */
export function undoableRuns(listing: AutomationListing | null): readonly UndoableRun[] {
  if (listing === null) return NO_RUNS;
  return listing.automations.flatMap(({ rule, log }) => {
    const last = lastUndoableRun(log);
    if (last === null) return [];
    return [
      {
        id: rule.path,
        name: rule.name,
        lastRun: `${shownTime(last.at)} · ${logEntrySummary(last)}`,
      },
    ];
  });
}

/**
 * A tab on the Automations page with Automations switched off (#901): the
 * notice, and under it each rule whose last run can still be undone. The
 * runner stays drawn while the feature is off, setting off no rule, so the
 * rules and their logs are read as ever and an undo goes through its one
 * door, after any run that was under way as the switch went off.
 */
export function AutomationsOffPage({
  wiring,
  chrome,
  onTurnOn,
}: Pick<PageContainerProps, 'wiring'> & { chrome: PageChrome; onTurnOn: () => void }) {
  const automations = useAutomationsController(wiring.pages.automations.store);
  return (
    <FeatureOffPage feature="automations" chrome={chrome} onTurnOn={onTurnOn}>
      {automations !== null && <PastRuns automations={automations} />}
    </FeatureOffPage>
  );
}

/** The undoable runs, and what the last undo did or why it could not (#920). */
function PastRuns({ automations }: { automations: AutomationsController }) {
  const { listing, busy, notice, setNotice, undo } = automations;
  const runs = useMemo(() => undoableRuns(listing), [listing]);
  const [done, setDone] = useState<string | null>(null);
  return (
    <PastRunsUndo
      runs={runs}
      busy={busy}
      // Why it could not is the runner's notice, which its one door sets on a failure.
      said={done ?? notice}
      onUndo={(id) => {
        const loaded = listing?.automations.find(({ rule }) => rule.path === id);
        if (loaded === undefined) return;
        setDone(null);
        setNotice(null);
        void undo(loaded.rule).then((entry) => {
          if (entry !== null) setDone(undoneSaid(loaded.rule.name, entry));
        });
      }}
    />
  );
}

/** What an undo that went through says: `Undid the last run of Sweep. Put back 2 notes.` */
export function undoneSaid(name: string, entry: LogEntry): string {
  return `Undid the last run of ${name}. ${logEntrySummary(entry)}`;
}
