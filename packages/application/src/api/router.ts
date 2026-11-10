import { apiWriteReport, insideVault, type VaultPath } from '@dfai/domain';
import type { ActivityRecorder } from '../activity/ports.ts';
import { failureOf } from './api-error.ts';
import type { ApiRequest, ApiResponse } from './contract.ts';
import { decodeSegment } from './paths.ts';
import type { ApiRouterDeps } from './ports.ts';
import { matchRoute, type RouteParams } from './routes.ts';
import { vaultRequest, type RouteResult } from './vault-request.ts';

/**
 * Answers one request from the local API.
 *
 * The host has already authenticated it (ADR-0016); this decides what it
 * means, with the same use-cases the UI runs. It never rejects: every outcome,
 * a fault of ours included, is an answer the host can hand back, and a fault
 * is answered as `internal` without its message or stack.
 *
 * A write — made or refused — is said in the Activity log by its route and
 * the note it named, never by what it carried (U-28).
 */
export async function routeApiRequest(
  request: ApiRequest,
  deps: ApiRouterDeps,
): Promise<ApiResponse> {
  let matched: ReturnType<typeof matchRoute> | null = null;
  // Taken as the request arrives: a write answered after a switch is still its own vault's.
  const activity = deps.activity.inOpenVault();
  try {
    matched = matchRoute(request.method, request.path);
    const answered = await answer(request, deps, matched);
    recordWrite({ activity, matched, answered });
    return { id: request.id, ...answered };
  } catch (error) {
    const failure = failureOf(error);
    if (matched !== null) recordWrite({ activity, matched, refusal: failure.body.error });
    return { id: request.id, ...failure };
  }
}

async function answer(
  request: ApiRequest,
  deps: ApiRouterDeps,
  { handler, params }: ReturnType<typeof matchRoute>,
): Promise<RouteResult> {
  if (!handler.needsVault) return handler.handle(deps);

  const bound = vaultRequest({ request, params, deps });
  try {
    return await handler.handle(bound);
  } catch (error) {
    // A failure after the vault was switched is the switch, whatever the host
    // called it: the write was refused because it named the vault it was for,
    // and a read failed on the other vault's index (a query_failed included).
    bound.assertStillOpen();
    throw error;
  }
}

/**
 * A line for a write route's answer. A refusal is recorded only when its
 * route writes; one for want of its vault (`no_vault`: none open, or another
 * opened since) is not, since the log open now is not that vault's.
 */
function recordWrite({
  activity,
  matched: { handler, params, route },
  answered,
  refusal = null,
}: {
  activity: ActivityRecorder;
  matched: ReturnType<typeof matchRoute>;
  answered?: RouteResult;
  /** What the caller was told: its code, and a message that is `internal`'s generic one for a fault. */
  refusal?: { code: string; message: string } | null;
}): void {
  if (!handler.needsVault || handler.wrote === undefined) return;
  if (answered !== undefined && !handler.wrote(answered)) return;
  if (refusal?.code === 'no_vault') return;
  const notePath = writtenNote({ route, params, answered });
  const refused =
    refusal === null ? { refusal: null } : { refusal: refusal.code, reason: refusal.message };
  activity.record(apiWriteReport({ route, notePath, ...refused }));
}

/** The note a write named: the one it made, as its answer says (a note, or a meeting's file), or the one in its URL. */
function writtenNote({
  route,
  params,
  answered,
}: {
  route: string;
  params: RouteParams;
  answered: RouteResult | undefined;
}): VaultPath | null {
  const made = answered?.body as { note?: { path?: unknown }; meeting?: { path?: unknown } };
  const path = made?.note?.path ?? made?.meeting?.path;
  if (typeof path === 'string') return insideVault(path);
  if (!route.includes('/v1/notes/{path}')) return null;
  try {
    return insideVault(decodeSegment(params.path));
  } catch {
    // An undecodable path was refused as `invalid` already; the line just has no link.
    return null;
  }
}
