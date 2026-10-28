import type { GranolaNoteProblem } from '@dfai/domain';
import type { GranolaPullReport } from '../granola/pull-granola-meetings.ts';
import { ApiError } from './api-error.ts';
import type { ApiGranolaNoteProblem, ApiGranolaPullReport } from './contract.ts';
import type { ApiGranola } from './ports.ts';
import type { RouteResult, VaultRequest } from './vault-request.ts';

/*
 * Granola through the API (P28-13): read, and one guarded pull. The key
 * stays in the host (ADR-0034), so no answer can carry it; every answer is
 * built field by field, so nothing the host or the puller adds rides along.
 */

/** `GET /v1/granola`: whether this Mac holds a key for the vault, and its record of the pulls. */
export async function granolaStatusRoute(request: VaultRequest): Promise<RouteResult> {
  const granola = granolaOf(request);
  const { hasKey } = await granola.keyStatus(request.vault);
  const { lastPullAt, watermark } = granola.record(request.vault);
  request.assertStillOpen();
  return { status: 200, body: { hasKey, lastPullAt, watermark } };
}

/**
 * `POST /v1/granola/pull`: the app's own Sync now, through its one puller, so
 * it never runs beside a pull of the app's. It is refused, before anything is
 * asked of Granola, when this Mac holds no key for the vault, or when the app
 * would not pull it yet either — sync has not pulled it this session, or the
 * index has not caught up (ADR-0034). One the API pulled less than 30 seconds
 * ago is `conflict` with `retryAfter`, as a source refresh is: a caller
 * looping on this route must not spend the key's rate limit in the user's name.
 */
export async function pullGranolaRoute(request: VaultRequest): Promise<RouteResult> {
  const granola = granolaOf(request);
  const { hasKey } = await granola.keyStatus(request.vault);
  request.assertStillOpen();
  if (!hasKey) throw new ApiError('conflict', NO_KEY);
  if (!granola.ready(request.vault)) throw new ApiError('conflict', NOT_READY);
  refuseTooSoon(request);

  const report = await granola.syncNow(request.vault);
  // A pull a vault switch ended is that switch.
  request.assertStillOpen();
  return { status: 200, body: { report: apiGranolaPullReport(report) } };
}

const NO_KEY =
  'This Mac holds no Granola key for this vault: set one in Settings → Granola, in DFAI.';

const NOT_READY =
  'DFAI pulls Granola into this vault once sync has pulled it this session and the index has ' +
  'caught up, so a meeting another Mac imported is not written twice. Try again in a moment.';

function granolaOf(request: VaultRequest): ApiGranola {
  if (request.granola === null) throw new ApiError('conflict', 'DFAI cannot reach Granola yet.');
  return request.granola;
}

/** Refuses a pull of a vault the API pulled too recently, saying how long is left. */
function refuseTooSoon(request: VaultRequest): void {
  // A source's key starts with the vault's absolute path, so this one is never a source's.
  const wait = request.refreshSpacing.claim({
    key: `granola\n${request.vault}`,
    now: request.clock.now(),
  });
  if (wait === 0) return;
  const retryAfter = Math.ceil(wait / 1000);
  throw new ApiError(
    'conflict',
    `Granola was pulled through the API moments ago; try again in ${retryAfter} s`,
    { retryAfter },
  );
}

function apiGranolaPullReport(report: GranolaPullReport): ApiGranolaPullReport {
  return {
    mode: report.mode,
    ended: report.ended,
    written: [...report.written],
    held: report.held,
    refused: report.refused.map(apiNoteProblem),
    skipped: report.skipped.map(apiNoteProblem),
    failed: report.failed.map(apiNoteProblem),
    problem: report.problem,
    keyRefused: report.keyRefused,
    watermark: report.watermark,
  };
}

function apiNoteProblem({ id, title, url, problem }: GranolaNoteProblem): ApiGranolaNoteProblem {
  return { id, title, url, problem };
}
