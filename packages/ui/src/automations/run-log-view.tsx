import { Icon } from '../icon.tsx';
import type { DryRunView, LogEntryView } from './automation-views.ts';

/** What a dry run found: the sentence, then each note it would take — one click from opening. */
export function DryRunResult({
  result,
  onOpenNote,
}: {
  result: DryRunView;
  onOpenNote: (path: string) => void;
}) {
  if (result.kind === 'error') {
    return (
      <section className="automation-dry-run" aria-label="Dry run">
        <p className="automation-editor__problem" role="alert">
          {result.message}
        </p>
      </section>
    );
  }
  return (
    <section className="automation-dry-run" aria-label="Dry run">
      <h3 className="page-section__title">{result.summary}</h3>
      {result.notes.length > 0 && (
        <ul className="page-list" aria-label="Notes it would take">
          {result.notes.map((note) => (
            <li key={note.path} className="page-list__row">
              <button type="button" className="table__link" onClick={() => onOpenNote(note.path)}>
                <Icon name="doc" size={15} />
                <span className="table__title">{note.title}</span>
              </button>
              <span className="automation-dry-run__path">{note.path}</span>
            </li>
          ))}
        </ul>
      )}
      {result.notLinked !== undefined && result.notLinked.length > 0 && (
        <ul className="page-list" aria-label="Meetings not linked">
          {result.notLinked.map((note) => (
            <li key={note.path} className="page-list__row">
              <button type="button" className="table__link" onClick={() => onOpenNote(note.path)}>
                <Icon name="doc" size={15} />
                <span className="table__title">{note.title}</span>
              </button>
              <span className="automation-dry-run__path">Not linked</span>
            </li>
          ))}
        </ul>
      )}
      {result.passedOver.length > 0 && (
        <ul className="automation-dry-run__passed" aria-label="Notes it would leave">
          {result.passedOver.map((note) => (
            <li key={`${note.title}:${note.reason}`}>
              {note.title}: {note.reason}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The rule's log, newest first: each run, undo and turning on, and every line of what it did. */
export function RunLog({ entries }: { entries: readonly LogEntryView[] }) {
  return (
    <section className="automation-log" aria-label="Run log">
      <h3 className="page-section__title">Log</h3>
      {entries.length === 0 ? (
        <p className="automation-log__empty">It has not run yet.</p>
      ) : (
        <ol className="automation-log__entries">
          {entries.map((entry) => (
            <li key={entry.id} className="automation-log__entry">
              <p className="automation-log__heading">{entry.heading}</p>
              <p className="automation-log__summary">{entry.summary}</p>
              {entry.lines.length > 0 && (
                <ul className="automation-log__lines">
                  {entry.lines.map((line, at) => (
                    <li
                      key={at}
                      className={`automation-log__line automation-log__line--${line.kind}`}
                    >
                      {line.text}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
