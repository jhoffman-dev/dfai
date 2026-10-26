import { createVaultPath, noteTitle, type ActivityReport, type GoogleProblem } from '@dfai/domain';
import type { BlockSyncReport } from './sync-blocks.ts';

const counted = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

const withFix = (problem: GoogleProblem) =>
  problem.fix === null ? problem.problem : `${problem.problem} ${problem.fix}`;

const aboutBlock = (
  path: string,
  level: ActivityReport['level'],
  message: string,
): ActivityReport => ({
  level,
  kind: 'source',
  message,
  subject: { kind: 'note', path: createVaultPath(path) },
});

const named = (path: string) => `“${noteTitle(createVaultPath(path))}”`;

/** What the sync wrote, in one line; null when it wrote nothing. */
function summaryLine(report: BlockSyncReport): ActivityReport | null {
  const parts = [
    report.inserted > 0 ? `${counted(report.inserted, 'block', 'blocks')} added` : null,
    report.pushed > 0 ? `${counted(report.pushed, 'block', 'blocks')} changed in Google` : null,
    report.pulled > 0 ? `${counted(report.pulled, 'block', 'blocks')} moved from Google` : null,
    report.missing > 0
      ? `${counted(report.missing, 'block', 'blocks')} marked as deleted in Google`
      : null,
  ].filter((part) => part !== null);
  if (parts.length === 0) return null;
  return {
    level: 'info',
    kind: 'source',
    message: `Blocks on Google Calendar: ${parts.join(', ')}.`,
    subject: null,
  };
}

/**
 * What a block sync says in Activity: why it stopped, else a line for what it
 * wrote and one for each block that needs saying — a conflict Google won, a
 * block that failed, one with nothing to push, one sharing another's event.
 * None when it wrote nothing and nothing went wrong.
 */
export function blockSyncActivity(report: BlockSyncReport): ActivityReport[] {
  if (report.problem !== null) {
    return [
      {
        level: 'warning',
        kind: 'source',
        message: `Blocks did not sync with Google Calendar: ${withFix(report.problem)}`,
        subject: null,
      },
    ];
  }
  const summary = summaryLine(report);
  return [
    ...(summary === null ? [] : [summary]),
    ...report.conflicts.map((path) =>
      aboutBlock(
        path,
        'info',
        `${named(path)} was changed in DFAI and in Google Calendar; Google’s time was kept.`,
      ),
    ),
    ...report.failed.map(({ path, problem }) =>
      aboutBlock(
        path,
        'warning',
        `${named(path)} did not sync with Google Calendar: ${withFix(problem)}`,
      ),
    ),
    ...report.unplaced.map((path) =>
      aboutBlock(
        path,
        'warning',
        `${named(path)} is not on Google Calendar: it needs a start and an end time, the end after the start.`,
      ),
    ),
    ...report.duplicates.map((path) =>
      aboutBlock(
        path,
        'warning',
        `${named(path)} is not synced: another block has the same Google event. Clear its gcal_ properties to give it its own.`,
      ),
    ),
  ];
}

/** What Settings says went wrong with the last sync: why it stopped, else the first block that failed. */
export function blockSyncProblem(report: BlockSyncReport): GoogleProblem | null {
  if (report.problem !== null) return report.problem;
  const [first] = report.failed;
  if (first === undefined) return null;
  return {
    problem: `${named(first.path)} did not sync: ${first.problem.problem}`,
    fix: first.problem.fix,
  };
}
