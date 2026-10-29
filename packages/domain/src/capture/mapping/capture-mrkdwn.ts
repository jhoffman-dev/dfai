import { pairEmphasis, type EmphasisMark } from './capture-emphasis.ts';
import { linkifyPhrasing } from './capture-linkify.ts';
import { cleanText, decodeSlackEntities, oneLineText } from './capture-text.ts';
import {
  blockquote,
  code,
  link,
  paragraph,
  text,
  type MdBlock,
  type MdPhrasing,
} from './capture-tree.ts';

/*
 * Slack's mrkdwn read into a markdown syntax tree (ADR-0049). Slack writes
 * `*bold*`, `_italic_`, `~strike~`, code, `<url|text>` links and `<@U…>`
 * mentions, and escapes `&`, `<` and `>` as entities. Each becomes its node;
 * everything else a sender wrote is a text node's words, and every address
 * GFM would read in them a link node of the mapper's (`linkifyPhrasing`).
 * No markdown is written here: the tree is written by the editor's own
 * serializer, which escapes what words need escaped.
 */

/** Who a `<@U…>` mention names, by Slack user id: the sender looks them up. */
export type SlackUserNames = Readonly<Record<string, string>>;

/** A message's text as blocks: paragraphs, Slack's quotes, and code blocks. */
export function slackToBlocks(words: string, users: SlackUserNames = {}): MdBlock[] {
  const blocks: MdBlock[] = [];
  for (const part of messageParts(cleanText(words))) {
    if (part.kind === 'code') blocks.push(code(part.value));
    else blocks.push(...proseBlocks(part.lines, users));
  }
  return blocks;
}

/** A message's text as plain words, for a title: formatting dropped, mentions and links by name. */
export function slackToPlain(words: string, users: SlackUserNames = {}): string {
  return messageParts(cleanText(words))
    .flatMap((part) =>
      part.kind === 'code'
        ? part.value.split('\n')
        : part.lines.map((line) => plainOf(lineToPhrasing(unquoted(line), users))),
    )
    .join('\n');
}

/** A sender's words that are not a message — a name — as phrasing: words, and links for their addresses. */
export function wordsToPhrasing(words: string): MdPhrasing[] {
  return linkifyPhrasing([text(words)]);
}

type MessagePart =
  | { readonly kind: 'code'; readonly value: string }
  | { readonly kind: 'prose'; readonly lines: readonly string[] };

/** Slack's code blocks: three backticks either side, across lines, never nested. */
const CODE_BLOCK = /```([\s\S]*?)```/g;

function messageParts(cleaned: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const prose = (from: number, to: number) => {
    if (to > from) parts.push({ kind: 'prose', lines: cleaned.slice(from, to).split('\n') });
  };
  let from = 0;
  for (const block of cleaned.matchAll(CODE_BLOCK)) {
    prose(from, block.index);
    const value = decodeSlackEntities(block[1] ?? '')
      .replace(/^\n/, '')
      .replace(/\n$/, '');
    parts.push({ kind: 'code', value });
    from = block.index + block[0].length;
  }
  prose(from, cleaned.length);
  return parts;
}

/** Slack's quote: `>` (sent as `&gt;`) opening a line. */
const QUOTE = /^(?:&gt;|>) ?/;

const unquoted = (line: string) => line.replace(QUOTE, '');

/**
 * Lines as blocks: a run of lines is one paragraph, its lines kept apart by
 * their line endings; a run of quoted lines is a quote; a blank line, or a
 * quoted one, ends a paragraph.
 */
function proseBlocks(lines: readonly string[], users: SlackUserNames): MdBlock[] {
  const blocks: MdBlock[] = [];
  let run: { quoted: boolean; paragraphs: string[][] } | null = null;
  const close = () => {
    if (run === null) return;
    const paragraphs = run.paragraphs
      .filter((each) => each.length > 0)
      .map((each) => paragraph(linkifyPhrasing(joinedLines(each, users))));
    if (paragraphs.length > 0) blocks.push(...(run.quoted ? [blockquote(paragraphs)] : paragraphs));
    run = null;
  };
  for (const line of lines) {
    const quoted = QUOTE.test(line);
    const words = unquoted(line);
    if (run !== null && run.quoted !== quoted) close();
    if (words.trim() === '') {
      if (quoted) (run ??= { quoted, paragraphs: [[]] }).paragraphs.push([]);
      else close();
      continue;
    }
    run ??= { quoted, paragraphs: [[]] };
    run.paragraphs.at(-1)?.push(words);
  }
  close();
  return blocks;
}

function joinedLines(lines: readonly string[], users: SlackUserNames): MdPhrasing[] {
  return lines.flatMap((line, at) => [
    ...(at === 0 ? [] : [text('\n')]),
    ...lineToPhrasing(line, users),
  ]);
}

/** Inline code, or one of Slack's `<…>` tokens: what is read before the words around it. */
const TOKEN = /`([^`\n]+)`|<([^<>\n]*)>/g;

/** Where a token sits among a line's characters while Slack's emphasis is paired: a mark no text holds. */
const TOKEN_MARK = '\u0000';

/** One atom of a line: a character of its words, or a token's node. */
type Atom = string | MdPhrasing;

/**
 * One line as phrasing. Code and tokens are read into their nodes first;
 * then Slack's emphasis is paired over the line, a token standing as one
 * mark no message holds (`cleanText` takes out control characters); then the
 * words between are text, their entities read.
 */
function lineToPhrasing(line: string, users: SlackUserNames): MdPhrasing[] {
  const atoms: Atom[] = [];
  let from = 0;
  for (const found of line.matchAll(TOKEN)) {
    atoms.push(...Array.from(line.slice(from, found.index)));
    const [, inline, token] = found;
    atoms.push(
      inline === undefined
        ? tokenNode(token ?? '', users)
        : { type: 'inlineCode', value: decodeSlackEntities(inline) },
    );
    from = found.index + found[0].length;
  }
  atoms.push(...Array.from(line.slice(from)));
  const characters = atoms.map((atom) => (typeof atom === 'string' ? atom : TOKEN_MARK));
  const { closes } = pairEmphasis(characters);
  return styledRange(atoms, closes, [0, atoms.length]);
}

const NODE_OF: Readonly<Record<EmphasisMark, 'strong' | 'emphasis' | 'delete'>> = {
  '*': 'strong',
  _: 'emphasis',
  '~': 'delete',
};

/**
 * The atoms from `start` to `end` as phrasing: each paired mark the node
 * Slack's mark makes, around what it pairs; every other run of characters
 * one text node, its entities read. Pairs never cross (`pairEmphasis`).
 */
function styledRange(
  atoms: readonly Atom[],
  closes: ReadonlyMap<number, number>,
  [start, end]: [number, number],
): MdPhrasing[] {
  const nodes: MdPhrasing[] = [];
  let words = '';
  const flush = () => {
    if (words !== '') nodes.push(text(decodeSlackEntities(words)));
    words = '';
  };
  for (let at = start; at < end; at += 1) {
    const atom = atoms[at] ?? '';
    const close = closes.get(at);
    if (close !== undefined && close < end) {
      flush();
      const type = NODE_OF[atom as EmphasisMark];
      nodes.push({ type, children: styledRange(atoms, closes, [at + 1, close]) });
      at = close;
    } else if (typeof atom === 'string') {
      words += atom;
    } else {
      flush();
      nodes.push(atom);
    }
  }
  flush();
  return nodes;
}

/** A web or mail address a link may open: `javascript:` and the like are never written as one. */
const LINKABLE = /^(?:https?:\/\/[^\s/<>]|mailto:[^\s<>])[^\s<>]*$/i;

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A `<…>` token as its node: a user, a channel or a special mention
 * (`<!here>`, a user group, a date with its fallback) as its words; a link to
 * a web or mail address as a link; a link of another scheme as its label's
 * words alone. Anything else in angle brackets — HTML in text that did not
 * come from Slack — is words.
 */
function tokenNode(token: string, users: SlackUserNames): MdPhrasing {
  const bar = token.indexOf('|');
  const target = bar === -1 ? token : token.slice(0, bar);
  const label = bar === -1 ? '' : oneLineText(decodeSlackEntities(token.slice(bar + 1)));
  if (target.startsWith('@')) {
    const id = target.slice(1);
    // Its own names only: `<@constructor>` must not read one from Object.prototype.
    const named = Object.hasOwn(users, id) ? (users[id] ?? '') : '';
    return text(`@${oneLineText(named) || label.replace(/^@/, '') || id}`);
  }
  if (target.startsWith('#')) return text(`#${label || target.slice(1)}`);
  if (target.startsWith('!')) return text(label || `@${target.slice(1).split('^')[0] ?? ''}`);
  // Slack writes `&` in an address as `&amp;`, as anywhere: the link opens the address it means.
  const address = decodeSlackEntities(target);
  if (LINKABLE.test(address)) return link(address, label || address);
  // Another scheme (`javascript:`, `slack://`) is never a link: what it says, at most.
  if (label !== '' && SCHEME.test(target)) return text(label);
  return text(decodeSlackEntities(`<${token}>`));
}

/** Phrasing as the words a reader sees: a link by its label, code by its text. */
function plainOf(nodes: readonly MdPhrasing[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'wikiLink') {
        return node.value;
      }
      return plainOf(node.children);
    })
    .join('');
}
