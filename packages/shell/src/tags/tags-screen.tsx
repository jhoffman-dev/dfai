import { formatTag, type VaultPath } from '@dfai/domain';
import { HiddenTitle, PageBar, TagsPage, type PageHistory, type TagTreeState } from '@dfai/ui';
import type { VaultTagsState } from './use-vault-tags.ts';
import { useTagsPage, type TagsPagePorts } from './use-tags-page.ts';

const CRUMB = { icon: 'tag', parent: 'Tags' } as const;

const EMPTY: readonly never[] = [];

/**
 * The tags page as a page: the bar and head every page has, then the tree and
 * the chosen tag's notes. It takes the place of the panes, as the graph does.
 */
export function TagsScreen({
  ports,
  tags,
  selected,
  indexKey,
  onChanged,
  onSelect,
  onOpenNote,
  onShowSidebar,
  history,
}: {
  ports: TagsPagePorts;
  tags: VaultTagsState;
  /** The chosen tag's key, or null for none. */
  selected: string | null;
  indexKey: string;
  onChanged: () => void;
  onSelect: (key: string | null) => void;
  onOpenNote: (path: VaultPath) => void;
  onShowSidebar?: () => void;
  history?: PageHistory;
}) {
  const page = useTagsPage({
    ports,
    counts: tags.kind === 'ready' ? tags.counts : EMPTY,
    selected,
    indexKey,
    onChanged,
    onSelect,
  });
  const tree: TagTreeState = tags.kind === 'ready' ? { kind: 'ready', tree: page.tree } : tags;
  const count = tags.kind === 'ready' ? tags.counts.length : 0;
  const name = page.node === null ? 'All tags' : formatTag(page.node.name);

  return (
    <>
      <PageBar
        crumb={CRUMB}
        name={name}
        {...(count > 0 && { count: `${count} ${count === 1 ? 'tag' : 'tags'}` })}
        {...(onShowSidebar !== undefined && { onShowSidebar })}
        {...(history !== undefined && { history })}
      />
      <div className="panel__body">
        <article className="page page--wide" aria-label="Tags">
          <HiddenTitle>{name}</HiddenTitle>
          <TagsPage
            tags={tree}
            sort={page.sort}
            onSortChange={page.setSort}
            selected={page.node}
            onSelect={onSelect}
            notes={page.notes}
            onOpenNote={onOpenNote}
            rename={{
              state: page.rename,
              onPreview: page.preview,
              onConfirm: page.confirm,
              onCancel: page.cancel,
            }}
            notice={page.notice}
          />
        </article>
      </div>
    </>
  );
}
