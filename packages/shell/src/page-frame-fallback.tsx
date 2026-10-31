import { Suspense, type ReactNode } from 'react';
import { PageBar, type PageHistory } from '@dfai/ui';

/** What a page's frame keeps from the page: the way back to the sidebar, and Back and Forward. */
export interface PageChrome {
  onShowSidebar?: () => void;
  history?: PageHistory;
}

/**
 * What a page loaded on first use shows while its chunk arrives: the page's own
 * frame — its bar, with Back and Forward where they will be, over an empty
 * body — so nothing moves when the page draws into it. Given children, the
 * body holds them instead.
 */
export function PageFrameFallback({
  onShowSidebar,
  history,
  children,
}: PageChrome & { children?: ReactNode }) {
  return (
    <>
      <PageBar
        crumb={null}
        name={null}
        {...(onShowSidebar !== undefined && { onShowSidebar })}
        {...(history !== undefined && { history })}
      />
      <div className="panel__body" {...(children === undefined && { 'aria-busy': true })}>
        {children}
      </div>
    </>
  );
}

/**
 * A page loaded on first use (`pages-on-first-use.ts`), drawn into its frame
 * once its chunk arrives, so nothing moves when it lands. The boundary sits
 * inside the page's container, so the container's reads begin while the
 * chunk is on its way.
 */
export function LoadedLater({ chrome, children }: { chrome: PageChrome; children: ReactNode }) {
  return <Suspense fallback={<PageFrameFallback {...chrome} />}>{children}</Suspense>;
}
