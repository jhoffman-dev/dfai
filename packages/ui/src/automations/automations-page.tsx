import type { ReactNode } from 'react';
import { PageAction, PageBar, type PageHistory } from '../page-bar.tsx';
import { HiddenTitle } from '../page-head.tsx';
import { Toggle } from '../toggle.tsx';
import type { AutomationRow } from './automation-views.ts';

export interface AutomationsPageProps {
  /** Null while the rules are being read. */
  readonly rows: readonly AutomationRow[] | null;
  readonly error: string | null;
  /** The rule open in the editor, by id; null for none. */
  readonly openId: string | null;
  /** The editor, when a rule is open or being made; it sits above the list. */
  readonly editor: ReactNode | null;
  /** The ready-made rules, by name, that "Add" offers. */
  readonly presets: readonly string[];
  readonly onNew: () => void;
  readonly onAddPreset: (name: string) => void;
  readonly onOpen: (id: string) => void;
  readonly onToggle: (id: string, enabled: boolean) => void;
  readonly onRunNow: (id: string) => void;
  /** What the last command did, or why it could not. */
  readonly notice: string | null;
  readonly busy: boolean;
  /** The offer to set meeting post-processing up in one yes (#191), above the rules. */
  readonly setup?: ReactNode;
  readonly onShowSidebar?: () => void;
  readonly history?: PageHistory;
}

/**
 * The Automations page (P25-03): every rule — on or off, when it last ran and
 * what it did, when it runs next — with the editor for the one open above
 * them. Ready-made rules are a click from being added.
 */
export function AutomationsPage(props: AutomationsPageProps) {
  const counted = describe(props.rows);
  const open = props.rows?.find((row) => row.id === props.openId) ?? null;
  const name = open?.name ?? (props.editor !== null ? 'New automation' : 'All automations');
  return (
    <>
      <PageBar
        crumb={{ icon: 'automation', parent: 'Automations' }}
        name={name}
        {...(counted !== null && { count: counted })}
        actions={<Adders {...props} />}
        {...(props.onShowSidebar !== undefined && { onShowSidebar: props.onShowSidebar })}
        {...(props.history !== undefined && { history: props.history })}
      />
      <div className="panel__body">
        <article className="page page--wide automations" aria-label="Automations">
          <HiddenTitle>{name}</HiddenTitle>
          {props.setup}
          {props.notice !== null && (
            <p className="automations__notice" role="status">
              {props.notice}
            </p>
          )}
          {props.editor}
          <RuleList {...props} />
        </article>
      </div>
    </>
  );
}

/** How many rules there are and how many run, beside the page's name; nothing when there are none. */
function describe(rows: readonly AutomationRow[] | null): string | null {
  if (rows === null || rows.length === 0) return null;
  const on = rows.filter((row) => row.enabled && row.problem === null).length;
  return `${rows.length} ${rows.length === 1 ? 'automation' : 'automations'}, ${on} on`;
}

function Adders({ presets, onNew, onAddPreset, busy }: AutomationsPageProps) {
  return (
    <div className="automations__adders">
      {presets.map((name) => (
        <PageAction
          key={name}
          icon="plus"
          label={name}
          tone="secondary"
          disabled={busy}
          onPress={() => onAddPreset(name)}
        />
      ))}
      <PageAction
        icon="plus"
        label="New automation"
        tone="primary"
        disabled={busy}
        onPress={onNew}
      />
    </div>
  );
}

function RuleList({ rows, error, openId, onOpen, onToggle, onRunNow, busy }: AutomationsPageProps) {
  if (error !== null) {
    return (
      <p className="table__error" role="alert">
        {error}
      </p>
    );
  }
  if (rows === null) return <p className="table__empty">Reading the automations…</p>;
  if (rows.length === 0) {
    return (
      <p className="automations__empty">
        No automations yet. Add the ready-made one above, or make your own.
      </p>
    );
  }
  return (
    <ul className="page-list automations__list" aria-label="All automations">
      {rows.map((row) => {
        // One line per row, so what it does is cut short; its title holds the whole of it.
        const what = row.problem ?? `${row.action} · ${row.schedule}`;
        return (
          <li
            key={row.id}
            className={
              row.id === openId
                ? 'page-list__row automation-card automation-card--open'
                : 'page-list__row automation-card'
            }
          >
            <Toggle
              label={`Run ${row.name} on its schedule`}
              checked={row.enabled}
              disabled={busy || row.problem !== null}
              onChange={(enabled) => onToggle(row.id, enabled)}
            />
            <div className="automation-card__main">
              <button
                type="button"
                className="automation-card__name"
                title={row.name}
                aria-current={row.id === openId ? 'true' : undefined}
                onClick={() => onOpen(row.id)}
              >
                {row.name}
              </button>
              <p className="automation-card__what" title={what}>
                {what}
              </p>
              {row.notice !== null && (
                <p className="automation-card__notice" role="status">
                  {row.notice}
                </p>
              )}
            </div>
            <dl className="automation-card__times">
              <div>
                <dt>Last run</dt>
                <dd>{row.lastRun ?? 'Never'}</dd>
              </div>
              <div>
                <dt>Next run</dt>
                <dd>{row.nextRun ?? '—'}</dd>
              </div>
            </dl>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              aria-label={`Run ${row.name} now`}
              disabled={busy || row.problem !== null}
              onClick={() => onRunNow(row.id)}
            >
              Run now
            </button>
          </li>
        );
      })}
    </ul>
  );
}
