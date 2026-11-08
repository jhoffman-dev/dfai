/*
 * The paths `git diff --name-only` prints, as the paths they are (PR #802's
 * attack). With `-z` they are NUL-separated and never quoted. Without it, git
 * puts a path with a byte outside printable ASCII, a quote or a backslash in
 * double quotes with C-style escapes (`core.quotePath`), so "e2e/café.spec.ts"
 * arrives as "e2e/caf\303\251.spec.ts" and matches nothing.
 */

const ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

/** One path as git printed it, unquoted: its escapes are bytes of UTF-8. */
export function unquoteGitPath(printed: string): string {
  if (printed.length < 2 || !printed.startsWith('"') || !printed.endsWith('"')) return printed;
  const bytes: number[] = [];
  const inner = printed.slice(1, -1);
  for (let at = 0; at < inner.length; at += 1) {
    const character = inner[at]!;
    if (character !== '\\') {
      bytes.push(...Buffer.from(character, 'utf8'));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(inner.slice(at + 1));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      at += 3;
    } else {
      const next = inner[at + 1] ?? '';
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
      at += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The paths in `git diff --name-only` output, `-z` or not, empty entries dropped. */
export function gitPaths(output: string): string[] {
  const entries = output.includes('\0')
    ? output.split('\0')
    : output.split('\n').map(unquoteGitPath);
  return entries.filter((path) => path !== '');
}
