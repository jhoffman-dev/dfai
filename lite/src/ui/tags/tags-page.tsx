import { useMemo } from 'react';
import { folderOf, noteTitle } from '../../application/index.ts';
import type { TagTreeNode } from '../../domain/tags/index.ts';
import { useApp } from '../services.ts';
import { useVault } from '../state/vault-store.ts';
import './tags.css';

const tagHref = (key: string) => `#/tags/${encodeURIComponent(key)}`;

function TagBranch({
  nodes,
  selected,
}: {
  nodes: readonly TagTreeNode[];
  selected: string | null;
}) {
  return (
    <ul className="tag-tree">
      {nodes.map((node) => (
        <li key={node.key}>
          <a
            className={`tag-chip${node.key === selected ? ' is-selected' : ''}`}
            href={tagHref(node.key)}
            aria-current={node.key === selected ? 'page' : undefined}
          >
            <span>#{node.label}</span>
            <span className="tag-count">{node.total}</span>
          </a>
          {node.children.length > 0 ? (
            <TagBranch nodes={node.children} selected={selected} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function TaggedNotes({ tag }: { tag: string }) {
  const { services } = useApp();
  const version = useVault((vault) => vault.version);
  const notes = useMemo(
    () => services.session.index.notesWithTag(tag),
    // `version` is the cue to ask the index again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [services, tag, version],
  );
  return (
    <section className="tagged-notes" aria-labelledby="tagged-heading">
      <h2 id="tagged-heading" className="tags-subheading">
        <span className="tag-pill">#{tag}</span>
        <span className="tag-count">{notes.length === 1 ? '1 note' : `${notes.length} notes`}</span>
      </h2>
      <ul className="tagged-list" aria-label={`Notes tagged ${tag}`}>
        {notes.map((path) => (
          <li key={path}>
            <a href={`#/note/${encodeURIComponent(path)}`}>
              <span className="tagged-title">{noteTitle(path)}</span>
              <span className="tagged-folder">{folderOf(path)}</span>
            </a>
            <span className="tagged-summary">{services.session.index.summary(path)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Every tag in the vault as a tree with counts; choosing one lists its notes, nested tags included. */
export function TagsPage({ tag }: { tag: string | null }) {
  const { services } = useApp();
  const version = useVault((vault) => vault.version);
  const tree = useMemo(
    () => services.session.index.tagTree(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [services, version],
  );

  return (
    <div className="tags-page">
      <h1 className="page-title">Tags</h1>
      <div className="tags-layout">
        <nav aria-label="Tags" className="tags-nav">
          {tree.length === 0 ? (
            <p className="tags-empty">No tags yet. Type #idea in a note to make one.</p>
          ) : (
            <TagBranch nodes={tree} selected={tag} />
          )}
        </nav>
        {tag === null ? null : <TaggedNotes tag={tag} />}
      </div>
    </div>
  );
}
