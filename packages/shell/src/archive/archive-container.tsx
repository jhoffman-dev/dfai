import { ARCHIVE_SCOPE } from '@dfai/application';
import { LoadedLater } from '../page-frame-fallback.tsx';
import { archivePage } from '../pages-on-first-use.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import { useLastReadFailed, useScopedIndexKey } from '../reads/use-scoped-index-key.ts';
import { useArchivePage } from './use-archive.ts';

const ArchivePage = archivePage.Component;

/**
 * The Archive as a tab (tab-model.md, PR B): it lists what is archived
 * itself, so a search draws this and not the window. What puts notes in
 * the Archive and takes them out is the window's (`ArchiveCommands`), since
 * every page and menu archives through the same batch.
 */
export function ArchiveContainer({ wiring, chrome }: PageContainerProps) {
  const { pages, pane } = wiring;
  // Read again for news of the Archive and the projects alone (#327),
  // or any news after a failed read (#424).
  const [failed, tellFailed] = useLastReadFailed();
  const indexKey = useScopedIndexKey({
    status: pane.indexStatus,
    vault: pane.vault,
    reader: ['archive'],
    scope: ARCHIVE_SCOPE,
    failed,
  });
  const page = useArchivePage({
    ports: pages.ports,
    indexKey,
    open: true,
    commands: pane.archive,
  });
  tellFailed(page.error);
  return (
    <LoadedLater chrome={chrome}>
      <ArchivePage
        contents={page.contents}
        error={page.error}
        search={page.search}
        onSearch={page.setSearch}
        selection={page.choosing.selection}
        onClearSelection={page.choosing.clear}
        onOpen={pages.openNote}
        onUnarchive={page.unarchive}
        busy={pane.archive.busy}
        {...chrome}
      />
    </LoadedLater>
  );
}
