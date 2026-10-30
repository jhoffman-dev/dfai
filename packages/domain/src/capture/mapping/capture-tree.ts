/*
 * A capture's body as a markdown syntax tree (mdast's shapes, the nodes a
 * capture uses), never as markdown text (ADR-0049, third attack on PR #615):
 * a sender's words are only ever a `text` node's value or a link's label,
 * and every link is one the mapper made. The tree is written by the same
 * serializer, with the same settings, as the editor writes a block with
 * (`writeMarkdown`, the adapters'), so its escaping is the library's, not
 * ours. The domain has no markdown library, so it is handed the writer.
 */

export interface MdText {
  readonly type: 'text';
  readonly value: string;
}

export interface MdInlineCode {
  readonly type: 'inlineCode';
  readonly value: string;
}

/** A link to an absolute address; its label is words. */
export interface MdLink {
  readonly type: 'link';
  readonly url: string;
  readonly title: string | null;
  readonly children: readonly MdPhrasing[];
}

/** A wiki link the mapper writes itself, verbatim: a Person's `[[Mara Quill]]`. */
export interface MdWikiLink {
  readonly type: 'wikiLink';
  readonly value: string;
}

export interface MdStyled {
  readonly type: 'strong' | 'emphasis' | 'delete';
  readonly children: readonly MdPhrasing[];
}

export type MdPhrasing = MdText | MdInlineCode | MdLink | MdWikiLink | MdStyled;

export interface MdParagraph {
  readonly type: 'paragraph';
  readonly children: readonly MdPhrasing[];
}

export interface MdHeading {
  readonly type: 'heading';
  readonly depth: 2;
  readonly children: readonly MdPhrasing[];
}

/** Code: never with a language, so a sender's first line cannot name the fence `atlas-query`. */
export interface MdCode {
  readonly type: 'code';
  readonly lang: null;
  readonly meta: null;
  readonly value: string;
}

export interface MdBlockquote {
  readonly type: 'blockquote';
  readonly children: readonly MdBlock[];
}

export interface MdListItem {
  readonly type: 'listItem';
  readonly spread: false;
  readonly checked: null;
  readonly children: readonly MdBlock[];
}

export interface MdList {
  readonly type: 'list';
  readonly ordered: false;
  readonly start: null;
  readonly spread: false;
  readonly children: readonly MdListItem[];
}

export type MdBlock = MdParagraph | MdHeading | MdCode | MdBlockquote | MdList;

export interface MdRoot {
  readonly type: 'root';
  readonly children: readonly MdBlock[];
}

/** The serializer a capture's tree is written by: the editor's, for one block at a time. */
export type WriteMarkdown = (root: MdRoot) => string;

export const text = (value: string): MdText => ({ type: 'text', value });

export const paragraph = (children: readonly MdPhrasing[]): MdParagraph => ({
  type: 'paragraph',
  children,
});

export const blockquote = (children: readonly MdBlock[]): MdBlockquote => ({
  type: 'blockquote',
  children,
});

export const code = (value: string): MdCode => ({ type: 'code', lang: null, meta: null, value });

export const heading = (words: string): MdHeading => ({
  type: 'heading',
  depth: 2,
  children: [text(words)],
});

export const bulletList = (items: readonly (readonly MdPhrasing[])[]): MdList => ({
  type: 'list',
  ordered: false,
  start: null,
  spread: false,
  children: items.map((phrasing) => ({
    type: 'listItem',
    spread: false,
    checked: null,
    children: [paragraph(phrasing)],
  })),
});

/**
 * The characters a link's address cannot hold as written, by their percent
 * codes: those that would end it (`(`, `)`, `<`, `>`, a quote), the
 * backslash, `[`, `]` and `!`, which the index reads as a wiki link or an
 * embed even inside an address, a space or a character beyond ASCII, and an
 * `&` that starts an entity, which markdown would read as its character. An
 * IPv6 host's brackets are kept (third attack on PR #615): one `[` is no
 * wiki link, and encoded the address opens nothing.
 */
export function encodeAddress(url: string): string {
  const ipv6 = IPV6_HOST.exec(url);
  if (ipv6 === null) return encodeCharacters(url);
  // The brackets of an IPv6 host are the address's own: encoded, no browser opens it.
  const [, scheme = '', userinfo = '', host = '', rest = ''] = ipv6;
  return `${scheme}${encodeCharacters(userinfo)}${host}${encodeCharacters(rest)}`;
}

/** A web address whose host is an IPv6 literal: its scheme, user info, `[host]:port`, and the rest. */
const IPV6_HOST = /^(https?:\/\/)([^/?#@]*@)?(\[[0-9A-Fa-f:.]+\](?::\d*)?)((?:[/?#].*)?)$/i;

function encodeCharacters(text: string): string {
  return text.replace(/[()\\[\]!<>"'`\s]|&(?=#?[A-Za-z0-9]+;)|[^ -~]/gu, (character) =>
    encodeURIComponent(character).replace(/[!'()]/g, percent),
  );
}

const percent = (character: string) =>
  `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * A link to `url`, an absolute address, its label `label` as words. One
 * whose label is its own address — `www.x` for `http://www.x`, `a@b.c` for
 * `mailto:a@b.c` — is given its address as a title too: the editor reads a
 * link like that as an address typed bare (`isAutolinkOf`, the adapters'),
 * writes it back bare once its line is edited, and GFM then reads the
 * address on into the words after it. A link with a title it keeps.
 */
export function link(url: string, label: string): MdLink {
  const address = encodeAddress(url);
  const bare = url === label || url === `mailto:${label}` || url === `http://${label}`;
  return { type: 'link', url: address, title: bare ? address : null, children: [text(label)] };
}
