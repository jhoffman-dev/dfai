import { wikiLinkSpans } from './wikilink-spans.ts';

/**
 * Obsidian-style links: `[[Note]]`, `[[Note|shown text]]`, `[[Note#Heading]]`.
 *
 * The target is kept exactly as written. Resolving it to a file is a separate
 * concern, because the same text can match different notes in different vaults.
 */
export interface WikiLink {
  readonly target: string;
  /** `#Heading`, `#` included, or null. */
  readonly heading: string | null;
  readonly alias: string | null;
}

/** A link or, written `![[…]]`, an embed: the linked file shown in place. */
export interface WikiLinkOrEmbed extends WikiLink {
  readonly embed: boolean;
}

export type WikiLinkPiece =
  | { readonly kind: 'text'; readonly value: string }
  | ({ readonly kind: 'wikiLink' } & WikiLinkOrEmbed);

/**
 * Characters a link reads as its own syntax — a heading, a block, an alias,
 * the brackets — so a note whose name holds one cannot be linked to.
 */
const LINK_SYNTAX = /[#^[\]|]/;

/** The first character in `name` that no `[[link]]` to it could hold, or null. */
export function linkBreakingCharacter(name: string): string | null {
  return LINK_SYNTAX.exec(name)?.[0] ?? null;
}

/** What a wiki link shows when it is not given an alias. */
export function wikiLinkLabel(link: WikiLink): string {
  if (link.alias !== null) return link.alias;
  return link.heading === null ? link.target : `${link.target}${link.heading}`;
}

/** Writes a link back in the form it is read in. */
export function formatWikiLink(link: WikiLink & { readonly embed?: boolean }): string {
  const heading = link.heading ?? '';
  const alias = link.alias === null ? '' : `|${link.alias}`;
  const bang = link.embed === true ? '!' : '';
  return `${bang}[[${link.target}${heading}${alias}]]`;
}

/**
 * Splits markdown into plain pieces and links, by the one link grammar
 * (`wikiLinkSpans`): an escaped link, one broken over a line, or one in code
 * or a comment is text. A `!` before a link makes it an embed, `!` included.
 */
export function splitWikiLinks(text: string): WikiLinkPiece[] {
  const pieces: WikiLinkPiece[] = [];
  let cursor = 0;
  for (const { start, end, link } of wikiLinkSpans(text)) {
    if (start > cursor) pieces.push({ kind: 'text', value: text.slice(cursor, start) });
    pieces.push({ kind: 'wikiLink', ...link });
    cursor = end;
  }
  if (cursor < text.length) pieces.push({ kind: 'text', value: text.slice(cursor) });
  return pieces;
}
