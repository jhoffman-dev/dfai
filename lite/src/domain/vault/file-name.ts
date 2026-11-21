/**
 * Characters a note's name may not hold (the vault contract): the path
 * separators and what Finder or Windows refuse, plus what a `[[link]]` reads
 * as its own syntax, so every note can be linked to.
 */
const FORBIDDEN = /[/\\:*?"<>|#^[\]]/;
const FORBIDDEN_ALL = /[/\\:*?"<>|#^[\]]|\p{Cc}/gu;

/** Longest name in UTF-16 units, kept well under every filesystem's 255 bytes. */
export const MAX_NAME_LENGTH = 120;

/** The first character in a name the vault forbids, or null when it has none. */
export function forbiddenCharacter(name: string): string | null {
  return FORBIDDEN.exec(name)?.[0] ?? null;
}

/**
 * A name made safe to be a file name: each forbidden character becomes a
 * space, runs of space become one, and leading dots (which would hide the
 * file) and trailing dots and spaces go. Empty when nothing usable is left.
 */
export function cleanNoteName(name: string): string {
  return name
    .replace(FORBIDDEN_ALL, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '')
    .slice(0, MAX_NAME_LENGTH)
    .trimEnd();
}

/** Why `name` (without `.md`) cannot be a note's name as typed, or null when it can. */
export function noteNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Give the note a name.';
  const forbidden = forbiddenCharacter(trimmed);
  if (forbidden !== null) return `A note’s name cannot hold ${forbidden}`;
  if (trimmed.startsWith('.')) return 'A note’s name cannot start with a dot.';
  if (trimmed.length > MAX_NAME_LENGTH) return `Keep the name under ${MAX_NAME_LENGTH} characters.`;
  return null;
}
