/**
 * What DFAI may do on a Google account, one use at a time (ADR-0030,
 * ADR-0046). A sign-in asks for the scopes of the uses the person has turned
 * on, and no more: a new use is one more consent screen, asked for on top of
 * what was allowed before, so turning one on never takes another away.
 */

/** A thing DFAI does with Google, each with the narrowest scopes that do it. */
export type GoogleUse = 'blocks' | 'meetings' | 'export';

const SCOPE = 'https://www.googleapis.com/auth/';

/** Only the Drive files DFAI made itself, for an export (#501). */
export const GOOGLE_DRIVE_FILE_SCOPE = `${SCOPE}drive.file`;

/**
 * The scopes each use needs. `blocks` reaches only calendars DFAI made
 * itself; `meetings` reads events and changes none; `export` reaches only the
 * Drive files DFAI made. Two-way sync of blocks (#30) writes to DFAI's own
 * calendar, which `blocks` already allows.
 */
export const GOOGLE_SCOPES_BY_USE: Readonly<Record<GoogleUse, readonly string[]>> = {
  blocks: [`${SCOPE}calendar.app.created`],
  meetings: [`${SCOPE}calendar.events.readonly`],
  export: [GOOGLE_DRIVE_FILE_SCOPE],
};

/**
 * Whether `granted` holds every scope in `needed`. A use may need more than
 * one — two-way sync of blocks (#30) could — and having some is not enough.
 */
export function coversScopes(granted: readonly string[], needed: readonly string[]): boolean {
  return needed.every((scope) => granted.includes(scope));
}

/** Whether what Google granted covers every scope `use` needs. */
export function grantsUse(granted: readonly string[], use: GoogleUse): boolean {
  return coversScopes(granted, GOOGLE_SCOPES_BY_USE[use]);
}

/**
 * The scopes to sign in with again so `use` works: those already granted,
 * then the ones it adds. Null when they already cover it, so nobody is shown
 * a consent screen for nothing.
 */
export function scopesWith(granted: readonly string[], use: GoogleUse): string[] | null {
  if (grantsUse(granted, use)) return null;
  const adding = GOOGLE_SCOPES_BY_USE[use].filter((scope) => !granted.includes(scope));
  return [...granted, ...adding];
}
