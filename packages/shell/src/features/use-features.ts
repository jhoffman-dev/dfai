import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActivityLog,
  EntryPoint,
  EntryPointsOffered,
  MarkdownPort,
  VaultFsPort,
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
}): { readonly offered: EntryPointsOffered; readonly setting: FeaturesSetting } {
  const setting = useFeaturesSetting(read);
  const offered = offeredFor(platform, setting.off);
  const { loaded, off } = setting;
  useEffect(() => {
    if (loaded) void preloadFeatures(featuresOn(off));
  }, [loaded, off]);
  return { offered, setting };
}

/**
 * What a tab on a switched-off feature's page is handed (#901) — one object
 * while `offered` is the same — and the section Settings opens at when its
 * "Turn on in Settings" opened it. That is forgotten as Settings closes, by
 * whatever way, so Settings opened after opens at its top as ever.
 */
export function useFeatureOffWiring({
  offered,
  overlay,
  showOverlay,
}: {
  offered: EntryPointsOffered;
  overlay: Overlay | null;
  showOverlay: (overlay: Overlay) => void;
}): { readonly wiring: FeaturesWiring; readonly settingsAt: SettingsSectionLink | null } {
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
  const wiring = useMemo(() => ({ offered, onTurnOn }), [offered, onTurnOn]);
  return { wiring, settingsAt };
}

/** The palette's commands the window offers: one with an `entry` only while that is offered. */
export function paletteCommandsOffered<
  Command extends { readonly id: string; readonly entry?: EntryPoint | undefined },
>(commands: readonly Command[], offered: EntryPointsOffered): Command[] {
  return commands.filter((command) => command.entry === undefined || offered[command.entry]);
}
