/** A pasted Slack link's message, as the offer to save it draws it. */
export type SlackOfferView =
  | { readonly state: 'reading' }
  | {
      readonly state: 'ready';
      readonly author: string;
      readonly text: string;
      readonly replies: number;
      readonly attachments: number;
      readonly saving: boolean;
    }
  | {
      readonly state: 'saved';
      /** Written now, or found already in the vault. */
      readonly outcome: 'written' | 'in-vault';
      readonly kind: 'note' | 'task';
    }
  | {
      readonly state: 'problem';
      readonly problem: string;
      readonly fix: string;
      /** The fix is in Settings → Slack. */
      readonly inSettings: boolean;
    };

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function threadLine(replies: number, attachments: number): string | null {
  const parts = [
    replies > 0 ? count(replies, 'reply', 'replies') : null,
    attachments > 0 ? count(attachments, 'file', 'files') : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * The offer a pasted Slack message link makes (#105): the message read
 * through the host, then "Save as task" or "Save as note". The link itself
 * stays where it was pasted whatever is chosen, so a message that cannot be
 * read keeps only the link.
 */
export function SlackMessageOffer({
  view,
  onSave,
  onOpen,
  onOpenSettings,
  onDismiss,
}: {
  view: SlackOfferView;
  onSave: (kind: 'note' | 'task') => void;
  onOpen: () => void;
  onOpenSettings: () => void;
  onDismiss: () => void;
}) {
  return (
    <section className="slack-offer" aria-label="Slack message" aria-live="polite">
      <OfferBody view={view} onSave={onSave} onOpen={onOpen} onOpenSettings={onOpenSettings} />
      <button className="btn btn--ghost slack-offer__dismiss" type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </section>
  );
}

function OfferBody({
  view,
  onSave,
  onOpen,
  onOpenSettings,
}: {
  view: SlackOfferView;
  onSave: (kind: 'note' | 'task') => void;
  onOpen: () => void;
  onOpenSettings: () => void;
}) {
  switch (view.state) {
    case 'reading':
      return <p className="slack-offer__status">Reading the Slack message…</p>;
    case 'ready': {
      const thread = threadLine(view.replies, view.attachments);
      return (
        <>
          <p className="slack-offer__author">{view.author}</p>
          <p className="slack-offer__text" data-testid="slack-offer-text">
            {view.text}
          </p>
          {thread !== null && <p className="slack-offer__status">{thread}</p>}
          <div className="slack-offer__actions">
            <button
              className="btn btn--primary"
              type="button"
              disabled={view.saving}
              onClick={() => onSave('task')}
            >
              Save as task
            </button>
            <button
              className="btn btn--secondary"
              type="button"
              disabled={view.saving}
              onClick={() => onSave('note')}
            >
              Save as note
            </button>
          </div>
        </>
      );
    }
    case 'saved':
      return (
        <>
          <p className="slack-offer__status" role="status">
            {view.outcome === 'written'
              ? `Saved to the Inbox as a ${view.kind}.`
              : 'Already in your vault.'}
          </p>
          <div className="slack-offer__actions">
            <button className="btn btn--secondary" type="button" onClick={onOpen}>
              Open
            </button>
          </div>
        </>
      );
    case 'problem':
      return (
        <>
          <p className="settings__problem" role="alert">
            {view.problem}
          </p>
          <p className="slack-offer__status">{view.fix}</p>
          {view.inSettings && (
            <div className="slack-offer__actions">
              <button className="btn btn--secondary" type="button" onClick={onOpenSettings}>
                Open Settings
              </button>
            </div>
          )}
        </>
      );
  }
}
