import { useState } from 'react';
import { noteLinksLabel, type NoteLinkEntry, type NoteLinks, type VaultPath } from '@dfai/domain';
import { Icon } from './icon.tsx';
import { RelatedNotesList, type RelatedPanel } from './related-notes.tsx';

/** Another note naming this one in plain text, and the words around it. */
export interface MentionRow {
  readonly path: VaultPath;
  readonly title: string;
  readonly excerpt: string;
}

/** Where the search for unlinked mentions has got to. */
export type MentionsState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly mentions: readonly MentionRow[] }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * What this note is connected to, at its foot: one quiet line that opens into
 * the notes linking here, the notes this one links to — relations named — and,
 * on request, notes that name it without a link yet.
 *
 * Collapsed by default: it is something to look up, not something to read past.
 */
export function NoteLinksPanel({
  links,
  incomingTitle = 'Links here',
  onOpen,
  mentions,
  onFindMentions,
  onLinkMention,
  related,
}: {
  links: NoteLinks;
  /** What the notes linking here are headed: "Mentioned in" on a person's page. */
  incomingTitle?: string;
  onOpen: (path: VaultPath) => void;
  mentions: MentionsState;
  /** Looks for unlinked mentions; asked for only when that group is opened. */
  onFindMentions: () => void;
  onLinkMention: (path: VaultPath) => void;
  /**
   * Notes close in meaning and not linked yet (P32-03), as a section of its
   * own under the links; left out where the page offers none. Its toggle is
   * drawn here rather than by a component of its own, so a note opened with
   * it closed draws nothing more than it did without it.
   */
  related?: RelatedPanel;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <section className="mentions links" aria-label="Links">
        <button
          type="button"
          className="mentions__toggle"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
        >
          <Icon name="forward" size={14} className="mentions__chevron" />
          Links
          <span className="links__count">{noteLinksLabel(links)}</span>
        </button>
        {open && (
          <div className="links__groups">
            <LinkGroup
              title={incomingTitle}
              empty="Nothing links here yet."
              entries={links.incoming}
              onOpen={onOpen}
            />
            <LinkGroup
              title="Links from this note"
              empty="This note links nowhere yet."
              entries={links.outgoing}
              onOpen={onOpen}
            />
            <UnlinkedMentions
              mentions={mentions}
              onFind={onFindMentions}
              onOpen={onOpen}
              onLink={onLinkMention}
            />
          </div>
        )}
      </section>
      {related !== undefined && (
        <section className="mentions related" aria-label="Related notes">
          <button
            type="button"
            className="mentions__toggle"
            aria-expanded={related.open}
            onClick={related.onToggle}
          >
            <Icon name="forward" size={14} className="mentions__chevron" />
            Related notes
          </button>
          {related.open && <RelatedNotesList panel={related} onOpen={onOpen} />}
        </section>
      )}
    </>
  );
}

/** One group of links, headed, or a line saying it is empty. Shared with the aside's Backlinks tab. */
export function LinkGroup({
  title,
  empty,
  entries,
  onOpen,
}: {
  title: string;
  empty: string;
  entries: readonly NoteLinkEntry[];
  onOpen: (path: VaultPath) => void;
}) {
  return (
    <section className="links__group" aria-label={title}>
      <h3 className="links__heading">{title}</h3>
      {entries.length === 0 ? (
        <p className="links__empty">{empty}</p>
      ) : (
        <ul className="mentions__list">
          {entries.map((entry) => (
            <li key={`${entry.path}:${entry.via ?? ''}`}>
              <button
                type="button"
                className="mentions__link"
                aria-label={entry.via === null ? entry.title : `${entry.title} — ${entry.via}`}
                onClick={() => onOpen(entry.path)}
              >
                <Icon name={entry.via === null ? 'doc' : 'link'} size={16} />
                <span className="mentions__name">{entry.title}</span>
                {entry.via === null ? (
                  <span className="mentions__path">{entry.path}</span>
                ) : (
                  <span className="links__via">{entry.via}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The notes naming this one without a link, looked for only when opened. Shared with the aside. */
export function UnlinkedMentions({
  mentions,
  onFind,
  onOpen,
  onLink,
}: {
  mentions: MentionsState;
  onFind: () => void;
  onOpen: (path: VaultPath) => void;
  onLink: (path: VaultPath) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="links__group" aria-label="Unlinked mentions">
      <button
        type="button"
        className="links__heading links__heading--toggle"
        aria-expanded={open}
        onClick={() => {
          if (!open && mentions.kind === 'idle') onFind();
          setOpen((was) => !was);
        }}
      >
        <Icon name="forward" size={12} className="mentions__chevron" />
        Unlinked mentions
      </button>
      {open && <MentionList mentions={mentions} onOpen={onOpen} onLink={onLink} />}
    </section>
  );
}

function MentionList({
  mentions,
  onOpen,
  onLink,
}: {
  mentions: MentionsState;
  onOpen: (path: VaultPath) => void;
  onLink: (path: VaultPath) => void;
}) {
  if (mentions.kind === 'idle' || mentions.kind === 'loading') {
    return <p className="links__empty">Looking…</p>;
  }
  if (mentions.kind === 'failed') {
    return (
      <p className="links__empty links__empty--error" role="alert">
        {mentions.message}
      </p>
    );
  }
  if (mentions.mentions.length === 0) {
    return <p className="links__empty">No other note names this one without linking it.</p>;
  }
  return (
    <ul className="mentions__list">
      {mentions.mentions.map((mention) => (
        <li key={mention.path} className="links__mention">
          <button type="button" className="mentions__link" onClick={() => onOpen(mention.path)}>
            <Icon name="doc" size={16} />
            <span className="mentions__name">{mention.title}</span>
            <span className="links__excerpt">{mention.excerpt}</span>
          </button>
          <button
            type="button"
            className="btn btn--secondary links__link-button"
            aria-label={`Link the mention in ${mention.title}`}
            onClick={() => onLink(mention.path)}
          >
            Link
          </button>
        </li>
      ))}
    </ul>
  );
}
