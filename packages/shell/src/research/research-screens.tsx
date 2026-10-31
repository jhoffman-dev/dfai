import { useMemo } from 'react';
import { wikiLinkTargetFor, type VaultPath } from '@dfai/domain';
import type { VaultFsPort } from '@dfai/application';
import {
  HighlightsPage,
  LibraryPage,
  useSteadyCallback,
  type CoverSource,
  type OpenHow,
} from '@dfai/ui';
import { useVaultImages } from '../notes/use-images.ts';
import { browserClipboard } from '../settings/clipboard.ts';
import type { PageChrome } from '../page-frame-fallback.tsx';
import { useHighlightsPage, useLibraryPage } from './use-research-pages.ts';
import { useHighlightsRead, useLibraryRead, type ResearchReadPorts } from './use-research-reads.ts';

/*
 * The research area's two pages (#507), in a chunk of their own: fetched the
 * first time one is opened. Each reads its list through the index, applies
 * the domain's filters, and hands the page what it draws.
 */

export interface LibraryScreenProps extends ResearchReadPorts, PageChrome {
  /** Where a source's cover is read from: the vault, and only the vault. */
  readonly fs: VaultFsPort;
  readonly onOpen: (path: VaultPath, how: OpenHow) => void;
}

export function LibraryScreen({
  fs,
  onOpen,
  onShowSidebar,
  history,
  ...ports
}: LibraryScreenProps) {
  const read = useLibraryRead(ports);
  const page = useLibraryPage(read);
  const load = useVaultImages({ fs, resetKey: ports.vault, vaultOnly: true });
  const covers = useMemo<CoverSource>(() => {
    const byPath = new Map(
      read.kind === 'ready' ? read.entries.map((entry) => [entry.path, entry.cover]) : [],
    );
    return { coverOf: (path) => byPath.get(path as VaultPath) ?? null, load };
  }, [read, load]);
  return (
    <LibraryPage
      {...page}
      covers={covers}
      onOpen={onOpen}
      {...(onShowSidebar !== undefined && { onShowSidebar })}
      {...(history !== undefined && { history })}
    />
  );
}

export interface HighlightsScreenProps extends ResearchReadPorts, PageChrome {
  /** Every note's path, which an embed's target is worked out against. */
  readonly notePaths: readonly VaultPath[];
  readonly now: () => number;
  readonly onOpen: (path: VaultPath, block: string, how: OpenHow) => void;
}

export function HighlightsScreen({
  notePaths,
  now,
  onOpen,
  onShowSidebar,
  history,
  ...ports
}: HighlightsScreenProps) {
  const read = useHighlightsRead(ports);
  const page = useHighlightsPage(read, now);
  // Worked out only as a row is dragged — the source's bare name, or its path where the
  // name is shared — and steady, so a note added elsewhere draws no row again.
  const linkTargetOf = useSteadyCallback((path: VaultPath) => wikiLinkTargetFor(path, notePaths));
  const onCopyEmbed = useSteadyCallback((embed: string) => {
    // A denied clipboard leaves the embed uncopied; there is nothing here to retry or undo.
    browserClipboard.write(embed).catch(() => undefined);
  });
  return (
    <HighlightsPage
      {...page}
      onOpen={onOpen}
      linkTargetOf={linkTargetOf}
      onCopyEmbed={onCopyEmbed}
      {...(onShowSidebar !== undefined && { onShowSidebar })}
      {...(history !== undefined && { history })}
    />
  );
}
