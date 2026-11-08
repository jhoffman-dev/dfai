import { createHash } from 'node:crypto';
import type { FlakeRecord } from './e2e-flakes.ts';
import { FLAKE_EPIC, type Filed, type IssueReport } from './flake-issues.ts';
import { fenced, inert } from './inert-markdown.ts';

/*
 * The words the flake jobs write (#799): each flaky test's issue and the gate
 * `flaky` job's summary, and the nightly flake hunt's one issue and summary.
 */

/** The run a report comes from, and what it ran on: `pull request #812`, `main`. */
export interface RunLink {
  readonly url: string;
  readonly context: string;
}

/** GitHub refuses a title over 256 characters. */
const TITLE_LIMIT = 250;
/** GitHub refuses a body or comment over 65,536 characters. */
const BODY_LIMIT = 60_000;
export const HUNT_TITLE = 'Nightly e2e flake hunt: tests that failed';

const clipped = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

const bounded = (body: string) =>
  body.length <= BODY_LIMIT
    ? body
    : `${body.slice(0, BODY_LIMIT)}\n\n…cut short: the run's own report has the rest.`;

/**
 * A short, stable key for a test: its project, file and whole title hashed.
 * Two long titles that share their first 250 characters still differ here
 * (PR #802's attack), so the issue title, which a later flake finds the issue
 * by, is one per test however the readable part is cut.
 */
export function flakeKey(record: FlakeRecord): string {
  const named = `${record.project}\u0000${record.file}\u0000${record.title}`;
  return createHash('sha256').update(named).digest('hex').slice(0, 8);
}

/** One issue per test, found again by its key; the rest is for reading, cut to fit. */
export function flakyIssueTitle(record: FlakeRecord): string {
  return clipped(`Flaky e2e [${flakeKey(record)}]: ${record.file} › ${record.title}`, TITLE_LIMIT);
}

/** Where a test is, inert: no title can mention someone or link an issue. */
const named = (record: FlakeRecord) =>
  `${inert(record.title)} in ${inert(record.file)} (project ${inert(record.project)})`;

function sighting(record: FlakeRecord, run: RunLink): string {
  const report = record.reportUrl === undefined ? '' : ` Report and trace: ${record.reportUrl}`;
  return [
    `Failed, then passed on its retry, in [this run](${run.url}) on ${run.context}.${report}`,
    '',
    fenced(record.errorLines),
  ].join('\n');
}

/** The issue for a test that failed and then passed its retry in the gate. */
export function flakyIssueReport(record: FlakeRecord, run: RunLink): IssueReport {
  const body = [
    `${named(record)} is flaky: CI retried it and it passed, so it did not block` +
      ' anything, but it is a bug until it is fixed (#799).',
    '',
    sighting(record, run),
    '',
    'Fix it, or quarantine it with `quarantined(<this issue>)` from e2e/quarantine.ts' +
      ' while it is being fixed. Each later flake of this test comments here.',
  ].join('\n');
  return {
    title: flakyIssueTitle(record),
    body: bounded(body),
    comment: bounded(sighting(record, run)),
  };
}

function tracked(issue: Filed | undefined): string {
  if (issue === undefined) return 'no issue filed';
  const unlinked =
    issue.unlinked === undefined ? '' : `; not under #${FLAKE_EPIC} yet: ${inert(issue.unlinked)}`;
  return `#${issue.number} (${issue.action}${unlinked})`;
}

/** The gate `flaky` job's summary: each flaky test, its report, and its issue. */
export function flakySummary(
  records: readonly FlakeRecord[],
  filed: ReadonlyMap<string, Filed>,
): string {
  if (records.length === 0) return '### Flaky e2e tests\n\nNone: no test needed its retry.\n';
  const lines = records.map((record) => {
    const issue = filed.get(flakyIssueTitle(record));
    const where = record.reportUrl === undefined ? '' : ` ([report](${record.reportUrl}))`;
    return `- ${named(record)}${where}: ${tracked(issue)}`;
  });
  return [
    '### Flaky e2e tests',
    '',
    'Each failed and then passed its retry, so the gate stayed green; each is a bug to fix.',
    '',
    ...lines,
    '',
  ].join('\n');
}

/** The tests that failed, grouped under their spec file, in file order. */
function bySpec(records: readonly FlakeRecord[]): Map<string, FlakeRecord[]> {
  const groups = new Map<string, FlakeRecord[]>();
  for (const record of [...records].sort((a, b) => a.file.localeCompare(b.file))) {
    groups.set(record.file, [...(groups.get(record.file) ?? []), record]);
  }
  return groups;
}

/** The nightly hunt's findings: every test that failed a try, grouped by spec. */
export function huntFindings(
  records: readonly FlakeRecord[],
  run: RunLink,
  repeats: number,
): string {
  const sections = [...bySpec(records)].map(([file, tests]) =>
    [
      `#### ${inert(file)}`,
      ...tests.map((record) =>
        [
          `- ${inert(record.title)} (project ${inert(record.project)}): failed ${record.failures} of ${repeats}`,
          fenced(record.errorLines),
        ].join('\n'),
      ),
    ].join('\n\n'),
  );
  return [
    `${records.length} test(s) failed at least once in ${repeats} runs of the Linux e2e suite,` +
      ` [this run](${run.url}) on ${run.context}.`,
    '',
    ...sections,
  ].join('\n');
}

/** The one issue the nightly hunt keeps, opened the first night and commented on after. */
export function huntIssueReport(
  records: readonly FlakeRecord[],
  run: RunLink,
  repeats: number,
): IssueReport {
  const findings = huntFindings(records, run, repeats);
  const body = [
    'The nightly flake hunt (.github/workflows/e2e-flake-hunt.yml) repeats the whole Linux' +
      ' e2e suite and lists here every test that failed at least once (#799). Each night' +
      ' with a failure comments. Fix or quarantine each test, then close this.',
    '',
    findings,
  ].join('\n');
  return { title: HUNT_TITLE, body: bounded(body), comment: bounded(findings) };
}
