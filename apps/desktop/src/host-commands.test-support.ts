/**
 * Reading the host's command list out of `lib.rs`, and ADR-0051's platform
 * map out of its markdown, for the IPC contract test. Each takes the source as
 * text, so its own tests can feed it other layouts than today's.
 */

const HANDLER_START = 'generate_handler![';

/** The index just past the comment starting at `at`, or `at` when none starts there. */
function pastComment(source: string, at: number): number {
  if (source.startsWith('//', at)) {
    const end = source.indexOf('\n', at);
    return end === -1 ? source.length : end;
  }
  if (source.startsWith('/*', at)) {
    const end = source.indexOf('*/', at + 2);
    return end === -1 ? source.length : end + 2;
  }
  return at;
}

/**
 * The text between `generate_handler![` and its own closing bracket, with
 * comments and each entry's `#[...]` attributes left out. An attribute's
 * brackets (and the commas of `cfg(any(a, b))`) never reach the caller.
 */
function handlerBody(source: string): string | null {
  const start = source.indexOf(HANDLER_START);
  if (start === -1) return null;
  let body = '';
  let attributeDepth = 0;
  for (let at = start + HANDLER_START.length; at < source.length; at += 1) {
    const past = pastComment(source, at);
    if (past !== at) {
      at = past - 1;
      continue;
    }
    const character = source[at];
    if (attributeDepth === 0 && character === '#' && source[at + 1] === '[') {
      attributeDepth = 1;
      at += 1;
    } else if (attributeDepth > 0) {
      if (character === '[') attributeDepth += 1;
      if (character === ']') attributeDepth -= 1;
    } else if (character === ']') {
      return body;
    } else {
      body += character;
    }
  }
  return null;
}

/** The commands `generate_handler!` registers, by the name the webview invokes; null when there is no list. */
export function hostCommandsIn(librs: string): Set<string> | null {
  const body = handlerBody(librs);
  if (body === null) return null;
  return new Set(
    body
      .split(',')
      .map((entry) => entry.trim().split('::').at(-1) ?? '')
      .filter((name) => name !== ''),
  );
}

/** One row of ADR-0051's tables, its cells as written. */
export interface CommandFate {
  readonly command: string;
  readonly capability: string;
  readonly web: string;
  readonly windows: string;
}

const FENCE = /^\s*(```|~~~)/;

/** The markdown a reader sees: HTML comments and fenced code blocks left out. */
function renderedLines(markdown: string): string[] {
  const uncommented = markdown.replace(/<!--[\s\S]*?(-->|$)/g, '');
  const lines: string[] = [];
  let fenced = false;
  for (const line of uncommented.split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced) lines.push(line);
  }
  return lines;
}

const ROW = /^\|\s*`(\w+)`\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/;

/** Each table row whose first cell is a command, outside comments and code blocks. */
export function commandFatesIn(markdown: string): CommandFate[] {
  return renderedLines(markdown).flatMap((line) => {
    const cells = ROW.exec(line);
    if (cells === null) return [];
    const [, command = '', capability = '', web = '', windows = ''] = cells;
    return [{ command, capability, web, windows }];
  });
}
