import type { Datasource } from '@dfai/domain';
import type { SourceReport } from '@dfai/application';

/**
 * A source note: where it reads from, what the last refresh did, and a button.
 *
 * The notes themselves are ordinary notes elsewhere in the vault, so this panel
 * has nothing to draw them with — it is the control room, not the data.
 */
export function SourcePanel({
  source,
  report,
  refreshing,
  onRefresh,
  secrets = [],
  outsideVault = false,
  onChooseFile,
  fileProblem = null,
}: {
  source: Datasource;
  /** The last refresh, or null when none has run since the note was opened. */
  report: SourceReport | null;
  refreshing: boolean;
  /** Refreshes the source; left out where the platform cannot reach it, and nothing is offered. */
  onRefresh?: () => void;
  /** The secrets this source sends, by name. */
  secrets?: readonly string[];
  /** A file named by its absolute path, which opens only on the Mac it was picked on. */
  outsideVault?: boolean;
  /** Picks the file a SQLite source reads; absent for the other kinds. */
  onChooseFile?: () => void;
  /** Why the last attempt to choose a file failed, if it did. */
  fileProblem?: string | null;
}) {
  return (
    <section className="source" aria-label="Source">
      <dl className="source__facts">
        <div className="source__fact">
          <dt>Reads</dt>
          <dd>{source.url ?? source.file}</dd>
        </div>
        <div className="source__fact">
          <dt>Format</dt>
          <dd>{source.format.toUpperCase()}</dd>
        </div>
        {source.query !== null && (
          <div className="source__fact source__fact--wide">
            <dt>Query</dt>
            <dd>
              <code className="source__query">{source.query}</code>
            </dd>
          </div>
        )}
        {secrets.length > 0 && (
          <div className="source__fact">
            <dt>Sends secrets</dt>
            <dd>
              {secrets.map((name) => (
                <code key={name}>{name}</code>
              ))}
            </dd>
          </div>
        )}
        <div className="source__fact">
          <dt>Writes to</dt>
          <dd>
            {source.into}/ as <code>{source.type}</code>
          </dd>
        </div>
        <div className="source__fact">
          <dt>Refreshes</dt>
          <dd>
            {source.interval === 0
              ? 'only when you ask'
              : `every ${source.interval} minute${source.interval === 1 ? '' : 's'} while this note is open`}
          </dd>
        </div>
      </dl>

      <div className="source__actions">
        {onRefresh !== undefined && (
          <button
            type="button"
            className="source__refresh"
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
        {onChooseFile !== undefined && (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={onChooseFile}
            disabled={refreshing}
          >
            Choose file…
          </button>
        )}
      </div>

      {fileProblem !== null && (
        <p className="source__note" role="alert">
          {fileProblem}
        </p>
      )}

      {outsideVault && (
        <p className="source__note">
          This file is outside the vault. It is opened read-only, and only on the Mac it was chosen
          on — elsewhere, choose it again.
        </p>
      )}

      {report === null ? (
        <p className="source__empty">Not refreshed yet.</p>
      ) : (
        <Outcome report={report} />
      )}
    </section>
  );
}

function Outcome({ report }: { report: SourceReport }) {
  return (
    <div className="source__report">
      <p className="source__ran">
        Last refreshed at {new Date(report.ran).toLocaleTimeString()} from {report.from}
      </p>

      {report.error !== null && (
        <p className="source__error" role="alert">
          {report.error}
        </p>
      )}

      <ul className="source__counts">
        <Count label="records read" value={report.records} />
        <Count label="created" value={report.created} />
        <Count label="refreshed" value={report.replaced} />
        <Count label="kept your text" value={report.updated} />
        <Count label="no longer in the feed" value={report.missing} />
        <Count label="skipped, no key" value={report.unkeyed} />
      </ul>

      {report.truncated && (
        <p className="source__warning" role="status">
          This feed is longer than one refresh will write. The records past the limit were left
          alone rather than written.
        </p>
      )}

      {report.missing > 0 && (
        <p className="source__note">
          Notes whose record has gone are marked, never deleted — they are yours to keep or remove.
        </p>
      )}
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    // Labelled as one phrase: read aloud, "3 created" is the fact, and the
    // number and its name arriving separately is not.
    <li className="source__count" aria-label={`${value} ${label}`}>
      <span className="source__count-value">{value}</span> {label}
    </li>
  );
}
