import { scanMarkdown } from '../links/index.ts';
import {
  continuesTagSegment,
  EDGE_UNDERSCORE,
  hasTagLetter,
  startsTagSegment,
  tagKey,
} from './tag-name.ts';

/** A tag found in a note: where it is, `#` included, and its name as written. */
export interface TagMatch {
  readonly start: number;
  readonly end: number;
  /** As written, without the `#`. */
  readonly name: string;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * What may sit right before a tag's `#`: nothing, a space or line break, or an
 * opening bracket. Anything else makes the `#` part of something else — a word
 * (`C#`, `issue#12`), a URL fragment, an escape (`\#`), an entity (`&#35;`).
 */
const OPENS_TAG = /^[\s(]$/u;

/**
 * Every inline tag in a note's markdown, in order: `#` followed directly by
 * a word, nested with `/` (`#area/health`). `# Heading` is a heading, not a
 * tag. A `#` in code (fenced or inline), in a wiki link (`[[Note#Heading]]`),
 * in a markdown link, a URL, an HTML tag or a comment is never a tag.
 */
export function findTags(markdown: string): TagMatch[] {
  const shields = shieldedSpans(markdown);
  const found: TagMatch[] = [];
  let shield = 0;
  let at = markdown.indexOf('#');
  while (at !== -1) {
    // Spans are in order and apart, and `at` only grows: one pass over both.
    while (shield < shields.length && (shields[shield] as Span).end <= at) shield += 1;
    const inShield = shield < shields.length && (shields[shield] as Span).start <= at;
    const tag = inShield ? null : tagAt(markdown, at);
    if (tag !== null) found.push(tag);
    at = markdown.indexOf('#', tag === null ? at + 1 : tag.end);
  }
  return found;
}

/** A note's tags, each once by key, spelled as first written, in the order they first appear. */
export function noteTags(markdown: string): readonly { key: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const { name } of findTags(markdown)) {
    const key = tagKey(name);
    if (!seen.has(key)) seen.set(key, name);
  }
  return [...seen].map(([key, name]) => ({ key, name }));
}

/** Markup whose `#` is never a tag, in order, overlapping spans merged. */
function shieldedSpans(text: string): Span[] {
  const { links, comments, code } = scanMarkdown(text);
  const patterns = [
    /!?\[[^[\]\n]*\]\([^()[\n]*\)/g, // [text](target)
    /\b(?:https?|ftp|mailto|file):[^\s)>\]]+/g,
    /\bwww\.[^\s)>\]]+/g,
    /<[^<>\n]+>/g, // HTML tags and autolinks
  ];
  const spans: Span[] = [
    ...links,
    ...comments,
    ...code,
    ...patterns.flatMap((pattern) =>
      [...text.matchAll(pattern)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
      })),
    ),
  ].sort((left, right) => left.start - right.start);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last !== undefined && span.start < last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    } else merged.push(span);
  }
  return merged;
}

/** The code point starting at `index`, whole even when it takes two code units. */
function charAt(text: string, index: number): string | undefined {
  const point = text.codePointAt(index);
  return point === undefined ? undefined : String.fromCodePoint(point);
}

/** `#word`, `#a/b/c`: parts of word characters joined by single slashes. */
function tagAt(text: string, at: number): TagMatch | null {
  const before = text[at - 1];
  if (before !== undefined && !OPENS_TAG.test(before)) return null;
  let end = at + 1;
  /** Reads one part; false when it ended on `_`s, which also ends the tag. */
  const segment = (): boolean => {
    let last = end;
    for (let char = charAt(text, end); continuesTagSegment(char); char = charAt(text, end)) {
      end += (char as string).length;
      if (char !== EDGE_UNDERSCORE) last = end;
    }
    const whole = end === last;
    end = last;
    return whole;
  };
  if (!startsTagSegment(charAt(text, end))) return null;
  let whole = segment();
  while (whole && text[end] === '/' && startsTagSegment(charAt(text, end + 1))) {
    end += 1;
    whole = segment();
  }
  const name = text.slice(at + 1, end);
  return hasTagLetter(name) ? { start: at, end, name } : null;
}
