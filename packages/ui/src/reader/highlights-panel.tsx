import { useState } from 'react';
import type { PanelEntry } from './panel-entries.ts';

/*
 * The document's highlights beside it (#504, #505), in the order they come
 * in it: a PDF's or a book's, each reader saying what its place is called.
 * A click brings one into view; its comment is edited here, which edits the
 * note; it is removed here, after asking. One whose spot could not be found
 * says so rather than pretending.
 */

export interface HighlightsPanelProps {
  readonly entries: readonly PanelEntry[];
  /** What the panel says when there are none: how to make one. */
  readonly emptyHint: string;
  /** The one just asked for, lit for a moment. */
  readonly flashing: string | null;
  readonly onShow: (id: string) => void;
  readonly onEditComment: (request: { id: string; comment: string }) => Promise<boolean>;
  readonly onRemove: (id: string) => Promise<boolean>;
}

export function HighlightsPanel(props: HighlightsPanelProps) {
  const count = props.entries.length;
  return (
    <aside className="pdf-panel" aria-label="Highlights">
      <h2 className="pdf-panel__title">
        Highlights <span className="pdf-panel__count">{count}</span>
      </h2>
      {count === 0 ? (
        <p className="pdf-panel__empty">{props.emptyHint}</p>
      ) : (
        <ol className="pdf-panel__list">
          {props.entries.map((entry) => (
            <HighlightEntry key={entry.id} highlight={entry} {...props} />
          ))}
        </ol>
      )}
    </aside>
  );
}

function HighlightEntry({
  highlight,
  flashing,
  onShow,
  onEditComment,
  onRemove,
}: HighlightsPanelProps & { highlight: PanelEntry }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const classes = ['pdf-entry', `pdf-entry--${highlight.color}`];
  if (flashing === highlight.id) classes.push('pdf-entry--flash');
  return (
    <li className={classes.join(' ')} data-highlight-entry={highlight.id}>
      <button
        type="button"
        className="pdf-entry__show"
        disabled={!highlight.canShow}
        onClick={() => onShow(highlight.id)}
      >
        <span className="pdf-entry__page">{highlight.place}</span>
        <span className="pdf-entry__quote">{highlight.quote}</span>
      </button>
      {highlight.placeNote !== null && <p className="pdf-entry__lost">{highlight.placeNote}</p>}
      {editing ? (
        <CommentForm
          comment={highlight.comment}
          onSave={async (comment) => {
            // A refused save leaves the form open with what was typed.
            if (await onEditComment({ id: highlight.id, comment })) setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        highlight.comment !== '' && <p className="pdf-entry__comment">{highlight.comment}</p>
      )}
      {confirming ? (
        <div className="pdf-entry__confirm" role="group" aria-label="Delete this highlight?">
          <span>Delete this highlight from the note?</span>
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={() => void onRemove(highlight.id)}
          >
            Delete
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setConfirming(false)}
          >
            Keep
          </button>
        </div>
      ) : (
        !editing && (
          <div className="pdf-entry__actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setEditing(true)}
            >
              {highlight.comment === '' ? 'Add comment' : 'Edit comment'}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setConfirming(true)}
            >
              Delete…
            </button>
          </div>
        )
      )}
    </li>
  );
}

function CommentForm({
  comment,
  onSave,
  onCancel,
}: {
  comment: string;
  onSave: (comment: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(comment);
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="pdf-entry__form"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        // A refused save is said by the reader's notice; the form stays open to try again.
        void onSave(text).finally(() => setSaving(false));
      }}
    >
      <textarea
        aria-label="Comment"
        className="pdf-entry__field"
        autoFocus
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="pdf-entry__actions">
        <button type="submit" className="btn btn--primary btn--sm" disabled={saving}>
          Save
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
