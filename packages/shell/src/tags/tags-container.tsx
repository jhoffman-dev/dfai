import type { ComponentProps } from 'react';
import { TAGS_SCOPE } from '@dfai/application';
import { LoadedLater } from '../page-frame-fallback.tsx';
import { tagsScreen } from '../pages-on-first-use.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import { useScopedIndexKey } from '../reads/use-scoped-index-key.ts';

const TagsScreen = tagsScreen.Component;

type TagsScreenProps = ComponentProps<typeof TagsScreen>;

/**
 * What the tags page needs from the window: the vault's tags as the window
 * reads them (`useVaultTags`, which also suggests `#` completions), and the
 * one rename queue the API shares.
 */
export interface TagsWiring {
  readonly tags: TagsScreenProps['tags'];
  readonly renames: TagsScreenProps['ports']['renames'];
}

/** The tags page as a tab (tab-model.md, PR B), on the tag its place names. */
export function TagsContainer({
  wiring,
  chrome,
  selected,
}: PageContainerProps & { selected: string | null }) {
  const { pages, pane } = wiring;
  // Any note can take the chosen tag, so any note's news reads it again (#327).
  const indexKey = useScopedIndexKey({
    status: pane.indexStatus,
    vault: pane.vault,
    reader: ['tags'],
    scope: TAGS_SCOPE,
  });
  return (
    <LoadedLater chrome={chrome}>
      <TagsScreen
        ports={{
          index: pane.index,
          fs: pages.ports.fs,
          markdown: pane.notes.markdown,
          editors: pages.ports.editors,
          renames: pages.tags.renames,
        }}
        tags={pages.tags.tags}
        indexKey={indexKey}
        onChanged={pane.onChanged}
        onSelect={(tag) => pages.openPage({ kind: 'tags', tag })}
        onOpenNote={pages.openNote}
        selected={selected}
        {...chrome}
      />
    </LoadedLater>
  );
}
