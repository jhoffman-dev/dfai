import type { ComponentProps } from 'react';
import { RULE_QUERY_SCOPE } from '@dfai/application';
import { LoadedLater, PageFrameFallback } from '../page-frame-fallback.tsx';
import { automationsScreen } from '../pages-on-first-use.ts';
import { localClock } from '../today.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import { useScopedIndexKey } from '../reads/use-scoped-index-key.ts';
import { useAutomationsController, type AutomationsStore } from './automations-store.ts';
import { useMeetingSetup, type MeetingSetupWiring } from '../meetings/use-meeting-setup.ts';

const AutomationsScreen = automationsScreen.Component;

/**
 * What the Automations page needs from the window: where the runner says the
 * rules stand (`AutomationsRunner`, #326), and the ports it writes through.
 * The runner is the window's, since the clock runs the rules whatever page
 * shows; the page reads it from the store, so it draws with the rules, not
 * with the window.
 */
export interface AutomationsWiring {
  readonly store: AutomationsStore;
  readonly ports: ComponentProps<typeof AutomationsScreen>['ports'];
  /** Setting up meeting post-processing in one yes (#191), shared with the Inbox. */
  readonly setup: MeetingSetupWiring;
  /** Whether a rule may ask Claude here: the editor's "Ask Claude" action (#657). */
  readonly offersClaude: boolean;
}

/** The Automations page as a tab (P29, tab-model.md PR B). */
export function AutomationsContainer({ wiring, chrome }: PageContainerProps) {
  const { pages, pane } = wiring;
  const automations = useAutomationsController(pages.automations.store);
  // The rule editor's query builder asks of the whole vault, so any note's news reads it again (#327).
  const indexKey = useScopedIndexKey({
    status: pane.indexStatus,
    vault: pane.vault,
    reader: ['rule-editor'],
    scope: RULE_QUERY_SCOPE,
  });
  const setup = useMeetingSetup(pages.automations.setup, {
    vault: pane.vault,
    where: 'automations',
  });
  // The page's frame, as while its chunk loads, until the runner has said where the rules stand.
  if (automations === null) return <PageFrameFallback {...chrome} />;
  return (
    <LoadedLater chrome={chrome}>
      <AutomationsScreen
        automations={automations}
        ports={pages.automations.ports}
        clock={localClock}
        indexKey={indexKey}
        activity={pane.activity}
        vault={pane.vault}
        onOpenNote={pages.openNote}
        setup={setup}
        offersClaude={pages.automations.offersClaude}
        {...chrome}
      />
    </LoadedLater>
  );
}
