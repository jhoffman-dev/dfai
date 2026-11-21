import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createStore, type StoreApi } from 'zustand';
import {
  workOffered,
  type ActivityLog,
  type EntryPoint,
  type EntryPointsOffered,
  type MarkdownPort,
  type VaultFsPort,
  type WorkOffered,
} from '@dfai/application';
import { featuresOn } from '@dfai/domain';
import { SETTINGS_SECTIONS, type SettingsSectionLink } from '@dfai/ui';
import type { Overlay } from '../overlay.ts';
import { preloadFeatures } from '../pages-on-first-use.ts';
import type { FeaturesWiring } from './feature-off-page.tsx';
import { offeredFor } from './offered-for.ts';
import { useFeaturesSetting, type FeaturesSetting } from './use-features-setting.ts';

/**
 * What the window offers, the person's switches in Settings → Features taken
 * into account (#901), and the setting itself for that section. `offered` is
 * the platform's own object while every feature is on, and one object per off
 * list otherwise. The chunks of each feature that is on are fetched once the
 * vault's settings say so; those of one switched off are not.
 */
export function useFeatures({
  platform,
  ...read
}: {
  /** What the platform offers, decided as the shell mounted. */
  platform: EntryPointsOffered;
  fs: VaultFsPort;
  markdown: MarkdownPort;
  vaultKey: string | null;
  activity: Pick<ActivityLog, 'inOpenVault'>;
}): {
  readonly offered: EntryPointsOffered;
  /**
   * What work that starts by itself — Kindle's sync, the Slack paste
   * listener, the chat's checks — may start: held until the vault's settings
   * have answered (`workOffered`, ADR-0055). Runners read this, not
   * `offered`; it holds only the work entries, so a row or a page cannot.
   */
  readonly working: WorkOffered;
  readonly setting: FeaturesSetting;
  readonly known: StoreApi<boolean>;
} {
  const setting = useFeaturesSetting(read);
  const offered = offeredFor(platform, setting.off);
  const { loaded, answered, off } = setting;
  useEffect(() => {
    if (loaded) void preloadFeatures(featuresOn(off));
  }, [loaded, off]);
  // Told after the commit, so only what subscribes (a tab on a feature's page) draws for it.
  const [known] = useState(() => createStore<boolean>()(() => false));
  useEffect(() => known.setState(answered, true), [known, answered]);
  const working = workOffered(offered, { answered });
  return { offered, working, setting, known };
}

/**
 * What a tab on a switched-off feature's page is handed (#901) — one object
 * while `offered` is the same — and the section Settings opens at when its
 * "Turn on in Settings" opened it. That is forgotten as Settings closes, by
 * whatever way, so Settings opened after opens at its top as ever.
 */
export function useFeatureOffWiring({
  offered,
  platform,
  known,
  overlay,
  showOverlay,
  hideOverlay,
}: {
  offered: EntryPointsOffered;
  /** What the platform offers with every feature on: a page it lacks is not the switch's doing. */
  platform: EntryPointsOffered;
  known: StoreApi<boolean>;
  overlay: Overlay | null;
  showOverlay: (overlay: Overlay) => void;
  hideOverlay: (overlay: Overlay) => void;
}): { readonly wiring: FeaturesWiring; readonly settingsAt: SettingsSectionLink | null } {
  useOverlaysOffered({ offered, overlay, hideOverlay });
  const [settingsAt, setSettingsAt] = useState<SettingsSectionLink | null>(null);
  // Forgotten once Settings has been open and closed, so no later opening
  // inherits it, however the notice's own opening was drawn. While it is null,
  // as it is but for that one opening, nothing here draws again.
  const settingsWasOpen = useRef(false);
  useEffect(() => {
    if (overlay === 'settings') {
      settingsWasOpen.current = true;
    } else if (settingsWasOpen.current) {
      settingsWasOpen.current = false;
      if (settingsAt !== null) setSettingsAt(null);
    }
  }, [settingsAt, overlay]);
  const onTurnOn = useCallback(() => {
    setSettingsAt(SETTINGS_SECTIONS.features);
    showOverlay('settings');
  }, [showOverlay]);
  const wiring = useMemo(
    () => ({ offered, platform, onTurnOn, known }),
    [offered, platform, onTurnOn, known],
  );
  return { wiring, settingsAt };
}

/**
 * The overlay a feature's entry point opens, by the overlay: an Add PDF…
 * left open when Reading is switched off — on another Mac, say — closes, as
 * its command is gone.
 */
const OVERLAY_ENTRY: Partial<Record<Overlay, EntryPoint>> = {
  'add-pdf': 'addDocuments',
  'add-epub': 'addDocuments',
};

/** Closes the overlay that is up once its entry point stops being offered. */
function useOverlaysOffered({
  offered,
  overlay,
  hideOverlay,
}: {
  offered: EntryPointsOffered;
  overlay: Overlay | null;
  hideOverlay: (overlay: Overlay) => void;
}): void {
  const entry = overlay === null ? undefined : OVERLAY_ENTRY[overlay];
  const gone = entry !== undefined && !offered[entry];
  useEffect(() => {
    if (gone && overlay !== null) hideOverlay(overlay);
  }, [gone, overlay, hideOverlay]);
}

/** The palette's commands the window offers: one with an `entry` only while that is offered. */
export function paletteCommandsOffered<
  Command extends { readonly id: string; readonly entry?: EntryPoint | undefined },
>(commands: readonly Command[], offered: EntryPointsOffered): Command[] {
  return commands.filter((command) => command.entry === undefined || offered[command.entry]);
}
