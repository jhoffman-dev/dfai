/*
 * Text from a test (its title, its file, its error) put into an issue or a job
 * summary without acting there (PR #802's attack): no `@name` mention that
 * notifies someone, no `#12` that links or closes an issue, no backtick that
 * breaks out of a code span, no fence an error can close early.
 */

const ZERO_WIDTH_SPACE = '\u200b';

/**
 * `text` as plain Markdown that renders as written: Markdown's own characters
 * escaped, and a zero-width space after `@` and `#` before a digit, so GitHub
 * links neither.
 */
export function inert(text: string): string {
  return text
    .replace(/[\\`*_[\]<>|~]/g, '\\$&')
    .replace(/@/g, `@${ZERO_WIDTH_SPACE}`)
    .replace(/#(?=\d)/g, `#${ZERO_WIDTH_SPACE}`)
    .replace(/\n/g, ' ');
}

/** A fenced block of `lines`, its fence longer than any run of backticks in them. */
export function fenced(lines: readonly string[]): string {
  const body = lines.length > 0 ? lines : ['(no error message)'];
  const longest = Math.max(
    0,
    ...body.flatMap((line) => (line.match(/`+/g) ?? []).map((run) => run.length)),
  );
  const fence = '`'.repeat(Math.max(4, longest + 1));
  return [`${fence}text`, ...body, fence].join('\n');
}
