import { cleanText, decodeSlackEntities, oneLineText } from './capture-text.ts';

/*
 * Slack's mrkdwn read into DFAI markdown (ADR-0049). Slack writes `*bold*`,
 * `_italic_`, `~strike~`, code, `<url|text>` links and `<@U…>` mentions, and
 * escapes `&`, `<` and `>` as entities. Everything else in a message is the
 * sender's own words, and is written so markdown reads it as words: no
 * heading, tag, wiki link, embed, block id, HTML, table or fence can come out
 * of a message, only the formatting Slack itself shows.
 */

/** Who a `<@U…>` mention names, by Slack user id: the sender looks them up. */
export type SlackUserNames = Readonly<Record<string, string>>;

/** How each part of a message is written: as markdown for the note, or as plain words for its title. */
interface Writer {
  readonly words: (text: string) => string;
  readonly marks: { readonly '*': string; readonly _: string; readonly '~': string };
  readonly code: (content: string) => string;
  readonly link: (url: string, label: string) => string;
  readonly codeBlock: (content: string) => string[];
  readonly line: (line: string) => string;
  readonly quote: (words: string) => string;
}

/**
 * Every character markdown or DFAI reads as more than a character, escaped:
 * emphasis and code (`*`, `_`, `~`, a backtick), links, wiki links,
 * embeds, checkboxes and footnotes (`[`, `]`), HTML and quotes (`<`, `>`),
 * headings and tags (`#`), block ids (`^`), tables (`|`), the backslash
 * itself, so a sender's backslash cannot undo one of these, and an `&` that
 * starts an entity (`&lt;`, `&#60;`), which would be read as its character.
 * A bare address is kept from being a link of its own (`https\://`,
 * `www\.`): a link read from words runs on over the backslashes after it,
 * and would undo their escapes.
 */
const SPECIAL = /[\\`*_~[\]<>#^|]|&(?=#?[A-Za-z0-9]+;)|(?<=\bhttps?):(?=\/\/)|(?<=\bwww)\./gi;

/** The sender's words as markdown reads them back as words. */
export function escapeMarkdown(text: string): string {
  return text.replace(SPECIAL, '\\$&');
}

/** A line of only `-`, `=` or `+` (and spaces) would be a rule or underline a heading. */
const RULE_LINE = /^(\s*)([-=+])([\s\-=+]*)$/;

/** A web or mail address a link may open: `javascript:` and the like are never written as one. */
const LINKABLE = /^(?:https?:\/\/[^\s/<>]|mailto:[^\s<>])[^\s<>]*$/i;

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The characters a link's destination cannot hold as written, by their
 * percent codes: those that would end it (`(`, `)`, `<`, `>`, a quote), the
 * backslash, and `[`, `]` and `!`, which the index would read as a wiki
 * link or an embed inside the address.
 */
const encodeDestination = (url: string) =>
  url.replace(
    /[()\\[\]!<>"'`]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** The longest run of backticks in `text`. */
function longestBacktickRun(text: string): number {
  return Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
}

/** A link with its label as words: the label can open nothing, the address only what it says. */
export function markdownLink(url: string, label: string): string {
  return `[${escapeMarkdown(label)}](${encodeDestination(url)})`;
}

const MARKDOWN: Writer = {
  words: escapeMarkdown,
  marks: { '*': '**', _: '*', '~': '~~' },
  code: (content) => {
    const fence = '`'.repeat(longestBacktickRun(content) + 1);
    const pad = content.startsWith('`') || content.endsWith('`') ? ' ' : '';
    return `${fence}${pad}${content}${pad}${fence}`;
  },
  link: (url, label) => markdownLink(url, label),
  // No info string: a sender's first line can never name the fence `atlas-query`.
  codeBlock: (content) => {
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(content) + 1));
    return [fence, ...(content === '' ? [] : content.split('\n')), fence];
  },
  line: (line) => line.replace(RULE_LINE, '$1\\$2$3'),
  quote: (words) => (words === '' ? '>' : `> ${words}`),
};

const PLAIN: Writer = {
  words: (text) => text,
  marks: { '*': '', _: '', '~': '' },
  code: (content) => content,
  link: (_, label) => label,
  codeBlock: (content) => content.split('\n'),
  line: (line) => line,
  quote: (words) => words,
};

/** A message's text as DFAI markdown, line by line: code blocks fenced, every other line escaped. */
export function slackToMarkdown(text: string, users: SlackUserNames = {}): string[] {
  return tidyBlankLines(readMessage(text, users, MARKDOWN));
}

/** A message's text as plain words, for a title: formatting dropped, mentions and links by name. */
export function slackToPlain(text: string, users: SlackUserNames = {}): string {
  return readMessage(text, users, PLAIN).join('\n');
}

/** Slack's code blocks: three backticks either side, across lines, never nested. */
const CODE_BLOCK = /```([\s\S]*?)```/g;

function readMessage(text: string, users: SlackUserNames, writer: Writer): string[] {
  const cleaned = cleanText(text);
  const lines: string[] = [];
  let from = 0;
  for (const block of cleaned.matchAll(CODE_BLOCK)) {
    lines.push(...proseLines(cleaned.slice(from, block.index), users, writer));
    const content = decodeSlackEntities(block[1] ?? '')
      .replace(/^\n/, '')
      .replace(/\n$/, '');
    lines.push(...writer.codeBlock(content));
    from = block.index + block[0].length;
  }
  lines.push(...proseLines(cleaned.slice(from), users, writer));
  return lines;
}

/** The lines between code blocks; none for the empty text a block at an end leaves. */
function proseLines(prose: string, users: SlackUserNames, writer: Writer): string[] {
  if (prose === '') return [];
  return prose.split('\n').map((line) => proseLine(line, users, writer));
}

/** Slack's quote: `>` (sent as `&gt;`) opening a line. */
const QUOTE = /^(?:&gt;|>) ?/;

function proseLine(line: string, users: SlackUserNames, writer: Writer): string {
  const words = writer.line(inlineText(line.replace(QUOTE, ''), users, writer));
  return QUOTE.test(line) ? writer.quote(words) : words;
}

/** Inline code, or one of Slack's `<…>` tokens: what is read before the words around it. */
const TOKEN = /`([^`\n]+)`|<([^<>\n]*)>/g;

/**
 * An address written as words, as GFM reads one into a link of its own
 * (`https://…`, `www.…`): taken up to a space, an angle bracket, a square
 * bracket or a held part, then cut back by {@link bareAddress}.
 */
// The character before is matched, not looked behind at: JavaScriptCore reads a
// lookbehind by code unit, and a letter beyond U+FFFF would let it start mid-word.
const BARE_ADDRESS = /(^|[^\p{L}\p{N}_])((?:https?:\/\/|www\.)[^\s<>[\]\u0000]+)/giu;

/** What ends a sentence after an address rather than belonging to it, as GFM cuts it. */
const TRAILING = /[?!.,:;*_~'"]+$/;

/**
 * An address found in words, and what after it is not part of it: trailing
 * punctuation, and a `)` the address did not open.
 */
function bareAddress(found: string): { address: string; after: string } {
  let address = found;
  for (;;) {
    const cut = address.replace(TRAILING, '');
    const opens = cut.split('(').length;
    const closes = cut.split(')').length;
    const next = cut.endsWith(')') && closes > opens ? cut.slice(0, -1) : cut;
    if (next === address) return { address, after: found.slice(address.length) };
    address = next;
  }
}

/** Slack's emphasis: a mark at a word's edge, the same mark closing it on the same line. */
const STYLED = /(^|[^\p{L}\p{N}])([*_~])(?!\s|\2)([^\n]*?[^\s])\2(?![\p{L}\p{N}])/gu;

/** Where a part already written sits in the line while the words round it are escaped. */
// eslint-disable-next-line no-control-regex -- NUL is the mark no cleaned message can hold
const HELD = /\u0000(\d+)\u0000/g;

/**
 * One line's words. Code and tokens are written first and held in their
 * places by a mark no message can hold (`cleanText` takes out every control
 * character), then Slack's emphasis, then the words between are escaped, and
 * the held parts are put back.
 */
function inlineText(line: string, users: SlackUserNames, writer: Writer): string {
  const held: string[] = [];
  const hold = (written: string) => `\u0000${held.push(written) - 1}\u0000`;
  const tokened = line.replace(TOKEN, (_, code: string | undefined, token: string | undefined) =>
    hold(
      code === undefined
        ? tokenText(token ?? '', users, writer)
        : writer.code(decodeSlackEntities(code)),
    ),
  );
  // A bare address is written as an explicit link: GFM would read it as one anyway, and
  // a link it reads from words runs on over the escapes after it once they are edited.
  const linked = tokened.replace(BARE_ADDRESS, (_, before: string, found: string) => {
    const { address, after } = bareAddress(found);
    const label = decodeSlackEntities(address);
    const url = /^www\./i.test(label) ? `http://${label}` : label;
    return `${before}${hold(writer.link(url, label))}${after}`;
  });
  const styled = (text: string): string =>
    text.replace(STYLED, (_, before: string, mark: '*' | '_' | '~', inner: string) => {
      const written = hold(writer.marks[mark]);
      return `${before}${written}${styled(inner)}${hold(writer.marks[mark])}`;
    });
  const escaped = writer.words(decodeSlackEntities(styled(linked)));
  return escaped.replace(HELD, (_, at: string) => held[Number(at)] ?? '');
}

/**
 * A `<…>` token: a user, a channel, a special mention (`<!here>`, a user
 * group, a date with its fallback), or a link. Anything else in angle
 * brackets — HTML in text that did not come from Slack — is words.
 */
function tokenText(token: string, users: SlackUserNames, writer: Writer): string {
  const bar = token.indexOf('|');
  const target = bar === -1 ? token : token.slice(0, bar);
  const label = bar === -1 ? '' : oneLineText(decodeSlackEntities(token.slice(bar + 1)));
  if (target.startsWith('@')) {
    const id = target.slice(1);
    const name = oneLineText(users[id] ?? '') || label.replace(/^@/, '') || id;
    return writer.words(`@${name}`);
  }
  if (target.startsWith('#')) return writer.words(`#${label || target.slice(1)}`);
  if (target.startsWith('!')) {
    return writer.words(label || `@${target.slice(1).split('^')[0] ?? ''}`);
  }
  if (LINKABLE.test(target)) return writer.link(target, label || target);
  // Another scheme (`javascript:`, `slack://`) is never a link: what it says, at most.
  if (label !== '' && SCHEME.test(target)) return writer.words(label);
  return writer.words(decodeSlackEntities(`<${token}>`));
}

/** No blank lines at either end. Those inside are kept: a code block's are its own. */
function tidyBlankLines(lines: readonly string[]): string[] {
  const kept = [...lines];
  while ((kept[0] ?? 'x').trim() === '') kept.shift();
  while ((kept.at(-1) ?? 'x').trim() === '') kept.pop();
  return kept;
}
