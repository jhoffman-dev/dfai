import { TERMS_SCOPE, type NoteTemplate } from '@dfai/application';
import { useNoticeActivity } from '../activity/use-activity-log.ts';
import { LoadedLater } from '../page-frame-fallback.tsx';
import { termsPage } from '../pages-on-first-use.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import { useLastReadFailed, useScopedIndexKey } from '../reads/use-scoped-index-key.ts';
import { useTermsPage } from './use-terms-page.ts';

const TermsPage = termsPage.Component;

/** What the Terms page needs from the window beyond what every page is handed. */
export interface TermsWiring {
  /** The vault's templates, which a new term is made from. */
  readonly templates: readonly NoteTemplate[];
}

/**
 * The Terms page as a tab (tab-model.md, PR B): it reads the terms and the
 * vocabulary itself. A write it gives up on is said over the page, as the
 * window said it, and kept in the Activity log once; misheard spellings that
 * went into a person's or a company's note say which note.
 */
export function TermsContainer({ wiring, chrome }: PageContainerProps) {
  const { pages, pane } = wiring;
  // Read again for news of the terms, the people and the companies alone (#327),
  // or any news after a failed read (#424).
  const [failed, tellFailed] = useLastReadFailed();
  const indexKey = useScopedIndexKey({
    status: pane.indexStatus,
    vault: pane.vault,
    reader: ['terms'],
    scope: TERMS_SCOPE,
    failed,
  });
  const { page, notice, added } = useTermsPage({
    ports: {
      index: pane.index,
      fs: pages.ports.fs,
      markdown: pane.notes.markdown,
      editors: pane.editors,
    },
    open: true,
    indexKey,
    types: pane.types,
    templates: pages.terms.templates,
    notePaths: pane.notePaths,
    onChanged: pane.onChanged,
    activity: pane.activity,
  });
  tellFailed(page.error);
  useNoticeActivity({ errors: [notice], warnings: [] }, pane.activity);
  return (
    <LoadedLater chrome={chrome}>
      {notice !== null && (
        <p className="notice" role="alert">
          {notice}
        </p>
      )}
      {added !== null && (
        <p className="notice-bar" role="status">
          {added}
        </p>
      )}
      <TermsPage {...page} onOpen={pages.openNote} {...chrome} />
    </LoadedLater>
  );
}
