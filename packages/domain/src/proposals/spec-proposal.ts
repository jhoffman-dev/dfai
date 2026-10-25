/**
 * A dashboard or a view, asked for by Claude and made only on Accept
 * (P32-05). The local API never writes `.atlas` (ADR-0016), where both live,
 * so `make_dashboard` checks what it is asked for and leaves a proposal in
 * the Inbox; the app's Accept checks it again and writes the entry.
 *
 * A spec is `{ kind: 'dashboard', name, description?, widgets }` or
 * `{ kind: 'view', name, type, layout }`. Its name becomes the proposal's
 * title — what the person can edit — and the rest its `spec`.
 */

import { checkDashboardSpec, dashboardFrontmatter } from '../dashboard/dashboard-spec.ts';
import { draftFromEntry, entryFromDraft } from '../dashboard/widget-draft.ts';
import { asFilters } from '../query/frontmatter-query.ts';
import type { SpecProblem } from '../errors/spec-problem.ts';
import { newViewNote, usableViewName, VIEWS_FOLDER } from '../query/new-view.ts';
import { checkViewSpec } from '../query/view-spec.ts';
import { digestOf } from '../sources/merge.ts';
import type { ObjectType } from '../types/property-def.ts';
import { createVaultPath, joinVaultPath, type VaultPath } from '../vault/vault-path.ts';
import { foldedVaultPath } from '../vault/vault-spelling.ts';
import { DASHBOARDS_DIRECTORY } from '../vault/vault-visibility.ts';
import type { ProposalApplication } from './proposal-application.ts';
import type { NewProposal } from './new-proposal.ts';
import { SPEC_PROPOSAL_KINDS, type SpecPayload, type SpecProposalKind } from './proposal.ts';

/** A spec that passed its checker: its kind, its title, and the rest as the proposal keeps it. */
export interface CheckedSpec {
  readonly kind: SpecProposalKind;
  readonly payload: SpecPayload;
}

/** What one check of a spec found: it, ready to propose, or everything wrong with it. */
export type SpecReading =
  | { readonly ok: true; readonly checked: CheckedSpec; readonly frontmatter: FrontMatter }
  | { readonly ok: false; readonly problems: readonly SpecProblem[] };

type FrontMatter = Readonly<Record<string, unknown>>;

const SPEC_KINDS_SAID = SPEC_PROPOSAL_KINDS.join(' or ');

/**
 * The spec checked by its kind's own checker — the widget editor's for a
 * dashboard, the New view dialog's for a view — against the vault's types,
 * with the frontmatter it would be written with.
 */
export function checkSpec(
  value: unknown,
  { types }: { types: readonly ObjectType[] },
): SpecReading {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refusedAt('spec', `A spec is a set of keys and values, with kind: ${SPEC_KINDS_SAID}.`);
  }
  const record = value as Readonly<Record<string, unknown>>;
  const kind = typeof record['kind'] === 'string' ? record['kind'].trim().toLowerCase() : '';
  if (kind === 'dashboard') return checkedDashboard(record, types);
  if (kind === 'view') return checkedView(record, types);
  return refusedAt('kind', `kind must be ${SPEC_KINDS_SAID}.`);
}

function checkedDashboard(record: Readonly<Record<string, unknown>>, types: readonly ObjectType[]) {
  const reading = checkDashboardSpec(record, { knownTypes: types.map(({ name }) => name) });
  if (!reading.ok) return reading;
  const { name, description, widgets } = reading.spec;
  const spec = { ...(description !== null && { description }), widgets };
  return {
    ok: true as const,
    checked: { kind: 'dashboard' as const, payload: { title: name, spec } },
    frontmatter: dashboardFrontmatter(reading.spec),
  };
}

function checkedView(record: Readonly<Record<string, unknown>>, types: readonly ObjectType[]) {
  const reading = checkViewSpec(record, { types });
  if (!reading.ok) return reading;
  const { request } = reading;
  const type = types.find((candidate) => candidate.name === request.type);
  // The checker found the type; this only tells the compiler so.
  if (type === undefined) return refusedAt('type', 'That type no longer exists.');
  return {
    ok: true as const,
    checked: {
      kind: 'view' as const,
      payload: { title: request.name, spec: { type: request.type, layout: request.layout } },
    },
    frontmatter: newViewNote(request, type).frontmatter,
  };
}

/**
 * The proposal a checked spec is left as. Its id is the spec's kind, title
 * and content, so asking for the same dashboard twice proposes it once —
 * even after the first was answered.
 */
export function specProposalFor({
  checked,
  madeBy,
}: {
  checked: CheckedSpec;
  madeBy: string;
}): NewProposal {
  const { kind, payload } = checked;
  const what = JSON.stringify([kind, payload.title.toLowerCase(), payload.spec]);
  return {
    kind,
    payload,
    confidence: null,
    source: null,
    madeBy,
    id: `spec-${digestOf(`a${what}`)}${digestOf(`b${what}`)}`,
    name: payload.title,
    reason: `Claude asked for this ${kind}. Nothing is written into .atlas until it is accepted here.`,
  };
}

/** Where each kind's entries live. */
export const SPEC_FOLDERS: Readonly<Record<SpecProposalKind, VaultPath>> = {
  dashboard: createVaultPath(DASHBOARDS_DIRECTORY),
  view: createVaultPath(VIEWS_FOLDER),
};

/**
 * What accepting a dashboard or view proposal writes, or why it may not be
 * accepted: its spec, with the title as its name, checked again against the
 * vault's types as they are now, written as a new entry in its kind's folder
 * — numbered past `takenPaths`, the entries already there, so nothing is
 * written over.
 */
export function applySpecProposal(
  { kind, payload }: CheckedSpec,
  { types, takenPaths }: { types: readonly ObjectType[]; takenPaths: readonly VaultPath[] },
): ProposalApplication {
  const reading = checkSpec({ ...payload.spec, kind, name: payload.title }, { types });
  if (!reading.ok) {
    const problems = reading.problems.map(({ at, message }) => `${at}: ${message}`).join(' ');
    return { ok: false, problem: `It no longer passes the ${kind} checker. ${problems}` };
  }
  const title = reading.checked.payload.title;
  const path = freeEntryPath(SPEC_FOLDERS[kind], title, takenPaths);
  return {
    ok: true,
    writes: [{ kind: 'create', path, properties: reading.frontmatter, body: `# ${title}\n` }],
  };
}

/**
 * Where an entry called `title` goes in `folder`: its name as a file can be
 * called, else numbered — `Board 2`, `Board 3` — each candidate cut to leave
 * room for its number, so a long name still fits the disk (as
 * `uniqueViewName` does). Names collide in any case, as the disk's do.
 */
function freeEntryPath(
  folder: VaultPath,
  title: string,
  takenPaths: readonly VaultPath[],
): VaultPath {
  const taken = new Set(takenPaths.map(foldedVaultPath));
  for (let suffix = 1; ; suffix += 1) {
    const ending = suffix === 1 ? '' : ` ${suffix}`;
    const path = joinVaultPath(folder, `${usableViewName(title, ending)}${ending}.md`);
    if (!taken.has(foldedVaultPath(path))) return path;
  }
}

function refusedAt(at: string, message: string): SpecReading {
  return { ok: false, problems: [{ at, message }] };
}

/** One widget as its card shows it: what Accept writes, in words. */
export interface WidgetSummary {
  readonly kind: string;
  readonly title: string;
  /** A `sql` widget's statement or a `query` widget's query, whole; null for a counting widget. */
  readonly asks: string | null;
  /** Each filter as `key operator value`. */
  readonly filters: readonly string[];
}

/** What a dashboard or view proposal would write, as its card shows it before Accept. */
export type SpecSummary =
  | {
      readonly kind: 'dashboard';
      readonly folder: VaultPath;
      readonly widgets: readonly WidgetSummary[];
    }
  | {
      readonly kind: 'view';
      readonly folder: VaultPath;
      readonly type: string;
      readonly layout: string;
    };

/**
 * A spec proposal as Accept will write it — each widget passed through the
 * editor's draft as the checker does (`entryFromDraft(draftFromEntry(…))`),
 * not as the proposal note holds it — so the card shows what is written,
 * every query whole.
 */
export function specSummary({ kind, payload }: CheckedSpec): SpecSummary {
  const { spec } = payload;
  if (kind === 'view') {
    return {
      kind,
      folder: SPEC_FOLDERS.view,
      type: text(spec['type']),
      layout: text(spec['layout']),
    };
  }
  const widgets = Array.isArray(spec['widgets']) ? (spec['widgets'] as unknown[]) : [];
  return { kind, folder: SPEC_FOLDERS.dashboard, widgets: widgets.map(widgetSummary) };
}

function widgetSummary(entry: unknown): WidgetSummary {
  const written = entryFromDraft(draftFromEntry(entry));
  const kind = text(written['kind']);
  const asks =
    kind === 'sql' ? text(written['sql']) : kind === 'query' ? text(written['query']) : '';
  return {
    kind,
    title: text(written['title']) || text(written['type']),
    asks: asks === '' ? null : asks,
    filters: asFilters(written['filters']).map(
      ({ key, operator, value }) =>
        `${key} ${operator}${value === undefined ? '' : ` ${String(value)}`}`,
    ),
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
