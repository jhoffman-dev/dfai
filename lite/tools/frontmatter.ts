// A small reader for the YAML frontmatter DFAI writes: flat keys with
// scalars, lists (block or `[a, b]`), and lists of flat maps (`attendees`).
// Anything deeper is kept as its raw text so the migration can still report it.

export type FrontmatterValue =
  | string
  | boolean
  | null
  | readonly string[]
  | readonly Readonly<Record<string, string | boolean>>[];

export interface Frontmatter {
  /** Keys in the order written. */
  readonly properties: ReadonlyMap<string, FrontmatterValue>;
  /** The note after the closing `---`. */
  readonly body: string;
}

const OPEN = /^---\r?\n/;
const CLOSE = /\r?\n---[ \t]*(?:\r?\n|$)/;
const KEY_LINE = /^([A-Za-z_][\w.-]*):(?:[ \t]+(.*))?$/;
const ITEM_LINE = /^\s+-(?:[ \t]+(.*))?$/;
const MAP_ENTRY = /^([A-Za-z_][\w.-]*):(?:[ \t]+(.*))?$/;

/** The note's frontmatter and the body after it; no frontmatter gives an empty map and the whole text. */
export function readFrontmatter(text: string): Frontmatter {
  const opened = OPEN.exec(text);
  if (opened === null) return { properties: new Map(), body: text };
  const rest = text.slice(opened[0].length);
  const closed = CLOSE.exec(`\n${rest}`);
  if (closed === null) return { properties: new Map(), body: text };
  const yaml = rest.slice(0, Math.max(0, closed.index - 1));
  const body = rest.slice(closed.index - 1 + closed[0].length);
  return { properties: readProperties(yaml.split(/\r?\n/)), body };
}

function readProperties(lines: readonly string[]): Map<string, FrontmatterValue> {
  const properties = new Map<string, FrontmatterValue>();
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] as string;
    const match = KEY_LINE.exec(line);
    at += 1;
    if (match === null) continue;
    const [, key = '', inline = ''] = match;
    if (inline.trim() !== '') {
      properties.set(key, scalarOrInlineList(inline));
      continue;
    }
    const block: string[] = [];
    while (at < lines.length && /^\s/.test(lines[at] as string)) block.push(lines[at++] as string);
    properties.set(key, block.length === 0 ? null : blockValue(block));
  }
  return properties;
}

/** An indented block under a key: a list of scalars, a list of maps, or raw text. */
function blockValue(block: readonly string[]): FrontmatterValue {
  const items: string[][] = [];
  for (const line of block) {
    const item = ITEM_LINE.exec(line);
    if (item !== null) items.push([item[1] ?? '']);
    else if (items.length > 0) (items.at(-1) as string[]).push(line.trim());
    else return block.map((raw) => raw.trim()).join('\n');
  }
  const isMap = items.some(([first = '']) => MAP_ENTRY.test(first) && !/^["']/.test(first));
  if (!isMap) return items.map(([first = '']) => String(scalar(first)));
  return items.map((lines) => {
    const entry: Record<string, string | boolean> = {};
    for (const line of lines) {
      const match = MAP_ENTRY.exec(line);
      if (match === null) continue;
      const value = scalar(match[2] ?? '');
      entry[match[1] ?? ''] = value === null ? '' : value;
    }
    return entry;
  });
}

function scalarOrInlineList(raw: string): FrontmatterValue {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return scalar(trimmed);
  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((part) => String(scalar(part.trim())));
}

/** A scalar: quotes taken off (`''` inside single quotes is one `'`), booleans and null read as such. */
function scalar(raw: string): string | boolean | null {
  const quoted = raw.trim();
  if (quoted.startsWith("'") && quoted.endsWith("'") && quoted.length >= 2) {
    return quoted.slice(1, -1).replace(/''/g, "'");
  }
  if (quoted.startsWith('"') && quoted.endsWith('"') && quoted.length >= 2) {
    return quoted.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  // A comment only ends an unquoted value.
  const text = quoted.replace(/\s+#.*$/, '').trim();
  if (text === '' || text === '~' || text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  return text;
}
