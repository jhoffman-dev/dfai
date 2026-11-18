import type { StoreApi } from 'zustand';
import type { EntryPointsOffered } from '@dfai/application';
import { featureById, type FeatureId } from '@dfai/domain';
import { FeatureOffNotice } from '@dfai/ui';
import { PageFrameFallback, type PageChrome } from '../page-frame-fallback.tsx';

/** What the pages read of the features switched off (#901). One object while neither part changes. */
export interface FeaturesWiring {
  /** What the window offers, the person's switches taken into account. */
  readonly offered: EntryPointsOffered;
  /** What the platform offers with every feature on (`pageTurnedOff` blames no switch for what it lacks). */
  readonly platform: EntryPointsOffered;
  /** Opens Settings at Features. */
  readonly onTurnOn: () => void;
  /**
   * Whether the open vault's settings have said which features are off: a
   * store, so only a tab on a feature's page hears it change, and a vault
   * opening draws nothing else for it.
   */
  readonly known: StoreApi<boolean>;
}

/**
 * A tab kept on the page of a feature switched off: the page's frame, with
 * its Back and Forward, around the notice saying so. The tab is not closed:
 * switching the feature on draws the page in it again.
 */
export function FeatureOffPage({
  feature,
  chrome,
  onTurnOn,
}: {
  feature: FeatureId;
  chrome: PageChrome;
  onTurnOn: () => void;
}) {
  return (
    <PageFrameFallback {...chrome}>
      <FeatureOffNotice label={featureById(feature).label} onTurnOn={onTurnOn} />
    </PageFrameFallback>
  );
}
