/*
 * Text from a test (its title, its file, its error) put into an issue or a job
 * summary without acting there (PR #802's attack): no `@name` mention that
 * notifies someone, no `#12` that links or closes an issue, no backtick that
 * breaks out of a code span, no fence an error can close early.
 */

const ZERO_WIDTH_SPACE = '\u200b';

/**
 * `text` as plain Markdown that renders as written: Markdown's own characters
 * escaped, `&` too, as GitHub decodes `&#64;` and `&#35;` before it looks
 * for mentions; a zero-width space after `@`, and inside `#` or `GH-` before
 * a digit, so GitHub links none of them; and on one line, so a title cannot
 * end a table row early.
 */
export function inert(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/[\\`*_[\]<>|~]/g, '\\$&')
    .replace(/@/g, `@${ZERO_WIDTH_SPACE}`)
    .replace(/#(?=\d)/g, `#${ZERO_WIDTH_SPACE}`)
    .replace(/\b(GH)-(?=\d)/gi, `$1${ZERO_WIDTH_SPACE}-`)
    .replace(/\r\n|\r|\n/g, ' ');
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
