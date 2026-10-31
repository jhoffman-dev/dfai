/**
 * The local API's contract for pulling meetings from Granola.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

import type { GranolaPullEnd, GranolaPullMode } from '@dfai/domain';

/**
 * Granola on this Mac for the vault (P28-13): whether a key is held, never
 * the key, and this Mac's record of its pulls.
 */
export interface ApiGranolaStatus {
  readonly hasKey: boolean;
  /** Granola refused the key this Mac holds (401): a new one is set in Settings → Granola. */
  readonly keyRefused: boolean;
  /** When this Mac last finished a pull of the vault, in milliseconds since the epoch; null before one. */
  readonly lastPullAt: number | null;
  /** Granola's `updated_at` this Mac lists the vault's notes from; null before a pull kept one. */
  readonly watermark: string | null;
}

/** A Granola note a pull did not write, and why. Never the note's content. */
export interface ApiGranolaNoteProblem {
  readonly id: string;
  readonly title: string | null;
  readonly url: string | null;
  readonly problem: string;
}

/** What one pull of Granola did, as Settings → Granola reports it. Never the key, never a note's content. */
export interface ApiGranolaPullReport {
  readonly mode: GranolaPullMode;
  readonly ended: GranolaPullEnd;
  /** The meetings written into the vault. */
  readonly written: readonly string[];
  /** Notes the vault already held. */
  readonly held: number;
  /** Notes the mapper refused, or whose transcript is past the limit. */
  readonly refused: readonly ApiGranolaNoteProblem[];
  /** Notes Granola refuses the same way on every pull, or listed in a shape DFAI cannot read. */
  readonly skipped: readonly ApiGranolaNoteProblem[];
  /** Notes that failed in a way that may pass: the next pull tries them again. */
  readonly failed: readonly ApiGranolaNoteProblem[];
  /** Why the pull stopped or failed, in the person's words; null when it did neither. */
  readonly problem: string | null;
  /** Granola refused the key (401): a new one is set in Settings → Granola. */
  readonly keyRefused: boolean;
  /** The watermark after the pull; null when none is kept yet. */
  readonly watermark: string | null;
}

/** What the routes for pulling meetings from Granola answer with. */
export type ApiGranolaSuccessBody = ApiGranolaStatus | { readonly report: ApiGranolaPullReport };

/** The routes for pulling meetings from Granola. */
export const GRANOLA_ROUTES = [
  {
    method: 'GET',
    path: '/v1/granola',
    summary:
      'Whether this Mac holds a Granola key for the vault (never the key), and its last pull and watermark.',
  },
  {
    method: 'POST',
    path: '/v1/granola/pull',
    summary:
      "Pull Granola's new meetings into the vault now, as Settings → Granola's Sync now does: once per vault per 30 s.",
  },
] as const;
