import { useEffect, useMemo } from 'react';
import { hideOverlay, showOverlay, useOverlayUp } from '../overlay-store.ts';
import { LoadedLater } from '../page-frame-fallback.tsx';
import { skillsPage } from '../pages-on-first-use.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import { useSkillUsers } from './skill-users-key.ts';
import { useSkillsPage, type SkillOverlay } from './use-skills-page.ts';

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
      show: (which: SkillOverlay) => showOverlay(overlays, which),
      hide: (which: SkillOverlay) => hideOverlay(overlays, which),
    }),
    [overlays],
  );
  // The questions are drawn from the window's store, the one place that says what is up.
  const deleteUp = useOverlayUp(overlays, 'skill-delete');
  const discardUp = useOverlayUp(overlays, 'skill-discard');
  // A tab closed with a question up takes it down with it, or it would hold the screen.
  useEffect(
    () => () => {
      hideOverlay(overlays, 'skill-delete');
      hideOverlay(overlays, 'skill-discard');
    },
    [overlays],
  );
  // Which rules use each skill, from the runner's own read: drawn again only when that changes.
  const rules = useSkillUsers(pages.automations.store);
  const page = useSkillsPage({
    ports: { fs: pages.ports.fs, markdown: pane.notes.markdown, overlay },
    rules,
    overlayUp: deleteUp ? 'skill-delete' : discardUp ? 'skill-discard' : null,
    vault: pane.vault,
    onOpenNote: pages.openNote,
  });
  return (
    <LoadedLater chrome={chrome}>
      <SkillsPage {...page} {...chrome} />
    </LoadedLater>
  );
}
