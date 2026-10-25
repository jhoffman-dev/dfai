import { useState } from 'react';
import {
  editedPayload,
  isNoteProposal,
  noteTitle,
  payloadFields,
  propertyText,
  proposalHeadline,
  specSummary,
  type PayloadFields,
  type ProposalConfidence,
  type ProposalKind,
  type ProposalNote,
  type SpecProposal,
} from '@dfai/domain';
import { Icon } from '../icon.tsx';
import { SelectBox } from '../row-selection.tsx';

export const KIND_LABEL: Readonly<Record<ProposalKind, string>> = {
  task: 'Task',
  'follow-up': 'Follow-up',
  decision: 'Decision',
  person: 'Person',
  link: 'Link',
  term: 'Term',
  project: 'Project',
  dashboard: 'Dashboard',
  view: 'View',
};

export interface ProposalRowProps {
  readonly proposal: ProposalNote;
  /** Why it was proposed, in its maker's words: whose it is, and what to check. Null or empty for none. */
  readonly reason?: string | null;
  /** While any proposal is being answered. */
  readonly busy: boolean;
  /** Why the last answer to this one was refused. */
  readonly problem: string | null;
  /** Accepts it, with its payload as edited when it was. */
  readonly onAccept: (payload?: unknown) => void;
  readonly onReject: () => void;
  readonly onOpen: () => void;
  readonly onOpenSource: (link: string) => void;
  /** Its box, to answer it with others at once (#168); none where proposals are answered one by one. */
  readonly selection?: {
    readonly checked: boolean;
    readonly onChange: (how: { readonly shift: boolean }) => void;
  };
}

/**
 * One proposal as a dense row (#307, FlowInbox.dc.html): its box, its kind,
 * what it would write and why, the line it cites, how sure its maker was —
 * a low confidence marks the whole row — and the answers: Reject, Edit
 * (change what it writes, then accept) and Accept, each in its own colour.
 */
export function ProposalRow(props: ProposalRowProps) {
  const { proposal, busy, problem, reason = null } = props;
  const unsure = proposal.confidence === 'low';
  const [fields, setFields] = useState<PayloadFields | null>(null);
  const headline = proposalHeadline(proposal);
  return (
    <section
      className={unsure ? 'proposal-row proposal-row--low' : 'proposal-row'}
      aria-label={`${KIND_LABEL[proposal.kind]}: ${headline}`}
    >
      <div className="proposal-row__line">
        <span className="proposal-row__select">
          {props.selection !== undefined && (
            <SelectBox
              label={`Select ${headline}`}
              checked={props.selection.checked}
              onChange={(_checked, how) => props.selection?.onChange(how)}
            />
          )}
        </span>
        <span className="proposal-row__kind" data-kind={proposal.kind}>
          {KIND_LABEL[proposal.kind]}
        </span>
        <div className="proposal-row__text">
          <span className="proposal-row__title">{headline}</span>
          {reason !== null && reason !== '' && <p className="proposal-row__why">{reason}</p>}
          {fields === null ? (
            <Payload proposal={proposal} />
          ) : (
            <PayloadForm fields={fields} onChange={setFields} />
          )}
          <Provenance {...props} />
          {problem !== null && (
            <p className="proposal-row__problem" role="alert">
              {problem}
            </p>
          )}
        </div>
        <ConfidencePill confidence={proposal.confidence} />
        <span className="proposal-row__actions">
          {fields === null ? (
            <>
              <button
                type="button"
                className="btn btn--sm btn--destructive"
                disabled={busy}
                onClick={props.onReject}
              >
                Reject
              </button>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                disabled={busy}
                onClick={() => setFields(payloadFields(proposal))}
              >
                Edit
              </button>
              <button
                type="button"
                className="btn btn--sm btn--positive"
                disabled={busy}
                onClick={() => props.onAccept()}
              >
                Accept
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                disabled={busy}
                onClick={() => setFields(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--sm btn--positive"
                disabled={busy}
                onClick={() => props.onAccept(editedPayload(proposal, fields))}
              >
                Accept as edited
              </button>
            </>
          )}
        </span>
      </div>
    </section>
  );
}

const CONFIDENCE_LABEL: Readonly<Record<ProposalConfidence, string>> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** How sure the maker was, as a status-style pill on its tint; nothing when it did not say. */
export function ConfidencePill({ confidence }: { confidence: ProposalConfidence | null }) {
  if (confidence === null) return <span className="proposal-row__confidence" />;
  return (
    <span
      className={`status-pill proposal-row__confidence proposal-row__confidence--${confidence}`}
    >
      <span className="status-pill__dot" aria-hidden="true" />
      {CONFIDENCE_LABEL[confidence]}
      <span className="visually-hidden"> confidence</span>
    </span>
  );
}

/** Where it came from: the line it cites — or a flag that it cites none — and what made it. */
function Provenance({ proposal, onOpen, onOpenSource }: ProposalRowProps) {
  return (
    <p className="proposal-row__provenance">
      {proposal.source === null ? (
        <span className="proposal-row__uncited">Cites no source</span>
      ) : (
        <button
          type="button"
          className="proposal-row__source"
          onClick={() => proposal.source !== null && onOpenSource(proposal.source)}
        >
          <Icon name="link" size={13} />
          {proposal.source}
        </button>
      )}
      {proposal.madeBy !== null && <span className="proposal-row__maker">{proposal.madeBy}</span>}
      <button type="button" className="proposal-row__file" onClick={onOpen}>
        Open proposal
      </button>
    </p>
  );
}

/** What Accept would write, as it stands. */
function Payload({ proposal }: { proposal: ProposalNote }) {
  if (proposal.kind === 'link') {
    const { note, property, link } = proposal.payload;
    return (
      <p className="proposal-row__change">
        Adds {link} to <b>{property}</b> of {noteTitle(note)}.
      </p>
    );
  }
  if (!isNoteProposal(proposal)) return <SpecPreview proposal={proposal} />;
  const { properties, body, linkFrom } = proposal.payload;
  const entries = Object.entries(properties);
  return (
    <>
      {entries.length > 0 && (
        <dl className="proposal-row__props" aria-label="What it would write">
          {entries.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{propertyText(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {body !== '' && <p className="proposal-row__body">{body}</p>}
      {linkFrom !== null && (
        <p className="proposal-row__change">
          And adds it to <b>{linkFrom.property}</b> of {noteTitle(linkFrom.note)}.
        </p>
      )}
    </>
  );
}

/**
 * What a dashboard or view would write, as Accept will write it
 * (`specSummary`): each widget's kind and title, its filters, and a SQL
 * statement or DFAI query whole — it runs once accepted, so it is read first.
 * A view shows its type and layout.
 */
function SpecPreview({ proposal }: { proposal: SpecProposal }) {
  const summary = specSummary(proposal);
  return (
    <>
      <dl className="proposal-row__props" aria-label="What it would write">
        {summary.kind === 'view' ? (
          <>
            <div>
              <dt>type</dt>
              <dd>{summary.type}</dd>
            </div>
            <div>
              <dt>layout</dt>
              <dd>{summary.layout}</dd>
            </div>
          </>
        ) : (
          summary.widgets.map((widget, at) => (
            <div key={at}>
              <dt>{widget.kind}</dt>
              <dd>{widget.title}</dd>
              {widget.filters.map((filter) => (
                <dd key={filter} className="proposal-row__spec-filter">
                  {filter}
                </dd>
              ))}
              {widget.asks !== null && (
                <dd>
                  <code className="proposal-row__spec-query">{widget.asks}</code>
                </dd>
              )}
            </div>
          ))
        )}
      </dl>
      <p className="proposal-row__change">
        Accepting makes it in <b>{summary.folder}</b>.
      </p>
    </>
  );
}

/** The payload's fields, to change before accepting. */
function PayloadForm({
  fields,
  onChange,
}: {
  fields: PayloadFields;
  onChange: (fields: PayloadFields) => void;
}) {
  if (fields.kind === 'spec') {
    return (
      <div className="proposal-row__form">
        <label>
          Name
          <input
            value={fields.title}
            onChange={(event) => onChange({ ...fields, title: event.target.value })}
          />
        </label>
      </div>
    );
  }
  if (fields.kind === 'link') {
    return (
      <div className="proposal-row__form">
        <label>
          Link
          <input
            value={fields.link}
            onChange={(event) => onChange({ ...fields, link: event.target.value })}
          />
        </label>
      </div>
    );
  }
  const setProperty = (at: number, text: string) =>
    onChange({
      ...fields,
      properties: fields.properties.map(([key, value], index) => [
        key,
        index === at ? text : value,
      ]),
    });
  return (
    <div className="proposal-row__form">
      <label>
        Title
        <input
          value={fields.title}
          onChange={(event) => onChange({ ...fields, title: event.target.value })}
        />
      </label>
      {fields.properties.map(([key, value], at) => (
        <label key={key}>
          {key}
          <input value={value} onChange={(event) => setProperty(at, event.target.value)} />
        </label>
      ))}
      <label>
        Body
        <textarea
          value={fields.body}
          rows={3}
          onChange={(event) => onChange({ ...fields, body: event.target.value })}
        />
      </label>
    </div>
  );
}
