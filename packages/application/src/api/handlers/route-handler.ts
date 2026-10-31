import type { ApiRouterDeps } from '../ports.ts';
import type { RouteResult, VaultHandler } from '../vault-request.ts';

/** What answers one route: a handler, and whether it needs the vault open. */
export type RouteHandler =
  | { readonly needsVault: false; readonly handle: (deps: ApiRouterDeps) => Promise<RouteResult> }
  | {
      readonly needsVault: true;
      readonly handle: VaultHandler;
      /**
       * Whether an answer is a write worth a line in the Activity log (U-28):
       * absent for a route that only reads, even one asked with POST.
       */
      readonly wrote?: (answer: RouteResult) => boolean;
    };

/** `GET /v1/status` and so on: one key per route, distributed over a union of routes. */
export type RouteKeyOf<Route> = Route extends { readonly method: string; readonly path: string }
  ? `${Route['method']} ${Route['path']}`
  : never;

/**
 * What answers each of an area's routes, keyed by the area's own contract, so
 * a route added there without a handler here is a type error, and so is a
 * handler for a route the area does not list.
 */
export type HandlerTable<Routes extends readonly unknown[]> = {
  readonly [Key in RouteKeyOf<Routes[number]>]: RouteHandler;
};

export const vaultRoute = (handle: VaultHandler): RouteHandler => ({ needsVault: true, handle });

/** A route that writes to the vault: every answer it gives is a write, unless `wrote` says which. */
export const vaultWrite = (
  handle: VaultHandler,
  wrote: (answer: RouteResult) => boolean = () => true,
): RouteHandler => ({ needsVault: true, handle, wrote });

/** An upload's last chunk, or a whole image, is answered 201; the chunks before it are not the write. */
export const created = (answer: RouteResult) => answer.status === 201;

/** A card that left a group, not one asked into the group it was already in. */
export const moved = (answer: RouteResult) => 'moved' in answer.body && answer.body.moved;

/** A rename or a merge, not the preview a `dryRun` (or no `confirm`) asks for. */
export const renamed = (answer: RouteResult) => 'report' in answer.body;
