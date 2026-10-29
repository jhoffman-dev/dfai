import { useEffect, useMemo } from 'react';
import { hideOverlay, showOverlay } from '../overlay-store.ts';
import { LoadedLater } from '../page-frame-fallback.tsx';
import { skillsPage } from '../pages-on-first-use.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import { useSkillsPage } from './use-skills-page.ts';

const SkillsPage = skillsPage.Component;

/**
 * The Skills page as a tab (#169, ADR-0050): it reads the skills and the
 * prompt notes itself, only while it is open, so start-up asks the host
 * nothing more. Its question before a delete is one of the window's
 * overlays, so nothing else opens over it.
 */
export function SkillsContainer({ wiring, chrome }: PageContainerProps) {
  const { pages, pane, overlays } = wiring;
  const overlay = useMemo(
    () => ({
      show: () => showOverlay(overlays, 'skill-delete'),
      hide: () => hideOverlay(overlays, 'skill-delete'),
    }),
    [overlays],
  );
  // A tab closed with its question up takes the question down with it, or it would hold the screen.
  useEffect(() => () => hideOverlay(overlays, 'skill-delete'), [overlays]);
  const page = useSkillsPage({
    ports: { fs: pages.ports.fs, markdown: pane.notes.markdown, overlay },
    vault: pane.vault,
    onOpenNote: pages.openNote,
  });
  return (
    <LoadedLater chrome={chrome}>
      <SkillsPage {...page} {...chrome} />
    </LoadedLater>
  );
}
