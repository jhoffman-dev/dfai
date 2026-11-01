import type { ComponentProps } from 'react';
import { LoadedLater } from '../page-frame-fallback.tsx';
import { templatesPage } from '../pages-on-first-use.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';

const TemplatesPage = templatesPage.Component;

/**
 * What the Templates page needs from the window: the page as
 * `useTemplatesPage` assembles it. That hook stays the window's, since its
 * questions are the window's dialogs and its commands reach every note's
 * menu, so the page draws with the window.
 */
export type TemplatesWiring = Omit<
  ComponentProps<typeof TemplatesPage>,
  'onShowSidebar' | 'history'
>;

/** The Templates page as a tab (tab-model.md, PR B). */
export function TemplatesContainer({ wiring, chrome }: PageContainerProps) {
  return (
    <LoadedLater chrome={chrome}>
      <TemplatesPage {...wiring.pages.templates} {...chrome} />
    </LoadedLater>
  );
}
