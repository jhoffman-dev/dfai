import { useMemo } from 'react';
import { documentKindOf, type VaultPath } from '@dfai/domain';
import { LoadedLater } from '../page-frame-fallback.tsx';
import { bookReader, documentReader } from '../pages-on-first-use.ts';
import { useTabReveal } from '../panes/reveals.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import type { DocumentPorts } from './use-document-highlights.ts';
import { useHeldReveal } from './held-reveal.ts';

const DocumentReader = documentReader.Component;
const BookReader = bookReader.Component;

/**
 * A PDF (#504) or an EPUB (#505) as a tab: its reader, loaded with pdf.js or
 * foliate-js the first time one opens. A highlight asked to be shown — `openDocumentAt` — reaches it as the
 * tab's reveal of the highlight's block, and is spent once shown.
 */
export function DocumentContainer({
  wiring,
  tabId,
  chrome,
  path,
}: PageContainerProps & { path: VaultPath }) {
  const { pages, pane, reveals } = wiring;
  const ports = useMemo<DocumentPorts>(
    () => ({
      fs: pages.ports.fs,
      markdown: pane.notes.markdown,
      index: pane.index,
      openNotes: pane.openNotes,
      onChanged: pane.onChanged,
    }),
    [pages.ports.fs, pane.notes.markdown, pane.index, pane.openNotes, pane.onChanged],
  );
  const reveal = useHeldReveal(useTabReveal(reveals, { tab: tabId, path }), path);
  if (pane.vault === null) return null;
  const Reader = documentKindOf(path) === 'epub' ? BookReader : DocumentReader;
  return (
    <LoadedLater chrome={chrome}>
      <Reader
        {...chrome}
        path={path}
        vault={pane.vault}
        ports={ports}
        reveal={reveal}
        onOpenNote={pages.openNote}
      />
    </LoadedLater>
  );
}
