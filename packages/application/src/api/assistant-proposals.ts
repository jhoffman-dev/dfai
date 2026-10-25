import { messageWithoutPaths, noteTitle, type SpecProblem, type VaultPath } from '@dfai/domain';
import {
  AssistantEntityError,
  MeetingGoneError,
  proposeMeetingTasks,
  proposeSpec,
  SpecRefusedError,
  type ProposedTasks,
} from '../assistant/index.ts';
import { ClaudeStepFailed } from '../automations/claude-step.ts';
import { ApiError } from './api-error.ts';
import { archivePorts } from './archive.ts';
import type { ApiProposedTasks } from './contract.ts';
import { bodyObject, requiredText } from './fields.ts';
import { isApiNotePath, notePathFrom } from './paths.ts';
import { spelledAsVault } from './vault-spelling.ts';
import type { RouteResult, VaultRequest } from './vault-request.ts';

/*
 * The assistant's two writes (P32-05), and both only propose: a meeting's
 * items drafted as proposals, and a dashboard or view spec checked and left
 * as one. Neither writes outside Inbox/Proposals; a dashboard or view is
 * written into `.atlas` only by Accept in the app (ADR-0016).
 */

/** What each proposal says made it. */
const MADE_BY = 'Claude, through the local API';

/**
 * How long the route waits for a meeting's draft before answering `202`:
 * under the host's 30 s, so a long meeting is not cut off as `timeout`. The
 * run goes on, and its proposals land in the Inbox all the same.
 */
export const PROPOSE_TASKS_WAIT_MS = 25_000;

/** `POST /v1/assistant/propose-tasks` `{ meeting }`: a meeting's items, as proposals. */
export async function proposeTasksRoute(request: VaultRequest): Promise<RouteResult> {
  const claude = request.claudeStep;
  if (claude === null) {
    throw new ApiError('conflict', 'DFAI cannot reach Claude yet: set it up in Settings → Claude.');
  }
  const meeting = await meetingOf(request);
  const key = `${request.vault}\n${meeting.normalize('NFC').toLowerCase()}`;
  if (!request.meetingDrafts.start(key)) {
    throw new ApiError('conflict', `${meeting} is being drafted already; its proposals follow.`);
  }
  // Asked before the draft starts, so the wait is the first thing timed.
  const waited = claude.deadline(PROPOSE_TASKS_WAIT_MS);
  const run = proposeMeetingTasks({
    ports: archivePorts(request),
    claude,
    meeting,
    madeBy: MADE_BY,
    // A vault switched while Claude answered: nothing lands in the one open now.
    beforeWrite: async () => request.assertStillOpen(),
  }).finally(() => request.meetingDrafts.finish(key));
  const answer = await within(run, waited);
  if (answer === null) {
    reportWhenDone(request, meeting, run);
    return { status: 202, body: { proposingTasks: { meeting, running: true } } };
  }
  return { status: 200, body: { proposedTasks: apiProposedTasks(answer) } };
}

/**
 * Says how a draft that outlived its `202` ended, since no caller is left to
 * hear it: in the vault's Activity log, and — when it failed — as a notice in
 * the window, naming the meeting and why.
 */
function reportWhenDone(request: VaultRequest, meeting: VaultPath, run: Promise<ProposedTasks>) {
  const subject = { kind: 'note' as const, path: meeting };
  run.then(
    (drafted) =>
      request.activity.record({
        level: 'info',
        kind: 'api',
        message: `Drafted ${drafted.proposed.length} proposals from ${noteTitle(meeting)}.`,
        subject,
      }),
    (error: unknown) => {
      const message = `Drafting the tasks of ${noteTitle(meeting)} stopped: ${messageWithoutPaths(error)}`;
      request.activity.record({ level: 'error', kind: 'api', message, subject });
      request.notices.warn(message);
    },
  );
}

/** `POST /v1/assistant/make-dashboard` `{ spec }`: a dashboard or view, checked and proposed. */
export async function makeDashboardRoute(request: VaultRequest): Promise<RouteResult> {
  const { spec } = bodyObject(request.body);
  if (spec === undefined) throw new ApiError('invalid', 'spec must be given');
  try {
    const proposed = await proposeSpec({ ports: archivePorts(request), spec, madeBy: MADE_BY });
    request.assertStillOpen();
    const { kind, title, proposal, problem } = proposed;
    return { status: 200, body: { proposedSpec: { kind, title, proposal, problem } } };
  } catch (error) {
    if (!(error instanceof SpecRefusedError)) throw error;
    const problems = boundedProblems(error.problems);
    const said = error.problems.length === 1 ? '1 problem' : `${error.problems.length} problems`;
    throw new ApiError('invalid', `The spec was refused: ${said}, each in problems.`, { problems });
  }
}

/** The most problems a refusal lists: enough to fix a spec in one go, never a page of them. */
export const MAX_SPEC_PROBLEMS = 50;

/** The most characters of one problem's words: a caller's long text is echoed cut, never whole. */
export const MAX_PROBLEM_CHARACTERS = 200;

/** A refusal's problems, kept to a size: so a spec of long text cannot make the answer a megabyte. */
function boundedProblems(problems: readonly SpecProblem[]): SpecProblem[] {
  // By whole code points, so a cut never leaves half of a surrogate pair behind.
  const cut = (text: string) => {
    const points = Array.from(text);
    return points.length > MAX_PROBLEM_CHARACTERS
      ? `${points.slice(0, MAX_PROBLEM_CHARACTERS - 1).join('')}…`
      : text;
  };
  const kept = problems.slice(0, MAX_SPEC_PROBLEMS).map(({ at, message }) => ({
    at: cut(at),
    message: cut(message),
  }));
  const more = problems.length - kept.length;
  return more > 0 ? [...kept, { at: 'spec', message: `… and ${more} more.` }] : kept;
}

/** The meeting the body names, as the vault spells it: a user-space `.md` note. */
async function meetingOf(request: VaultRequest): Promise<VaultPath> {
  const asked = notePathFrom(requiredText(bodyObject(request.body), 'meeting'), 'meeting');
  return spelledAsVault({ fs: request.fs, asked, accepts: isApiNotePath });
}

/**
 * The run's answer, or null once it has taken longer than the route waits.
 * A note that is no meeting, a meeting gone meanwhile, or a step that fails,
 * is refused as the caller can act on it.
 */
async function within(
  run: Promise<ProposedTasks>,
  waited: AbortSignal,
): Promise<ProposedTasks | null> {
  const late = new Promise<null>((resolve) => {
    // A signal that is aborted already never fires again.
    if (waited.aborted) resolve(null);
    else waited.addEventListener('abort', () => resolve(null), { once: true });
  });
  try {
    return await Promise.race([run, late]);
  } catch (error) {
    if (error instanceof AssistantEntityError) {
      throw new ApiError(error.reason === 'not_found' ? 'not_found' : 'invalid', error.message);
    }
    if (error instanceof MeetingGoneError) throw new ApiError('conflict', error.message);
    if (error instanceof ClaudeStepFailed) {
      throw new ApiError('conflict', `Claude could not draft it: ${messageWithoutPaths(error)}`);
    }
    throw error;
  }
}

function apiProposedTasks(drafted: ProposedTasks): ApiProposedTasks {
  return {
    meeting: drafted.meeting,
    proposed: drafted.proposed,
    alreadyProposed: drafted.alreadyProposed,
    unchanged: drafted.unchanged,
    dropped: drafted.dropped.map(({ title, reason }) => ({ title, reason })),
    left: drafted.left.map(({ path, reason }) => ({ path, reason })),
    warnings: drafted.warnings,
  };
}
