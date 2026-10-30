import { link, text, type MdLink, type MdPhrasing, type MdText } from './capture-tree.ts';

/*
 * Every address GFM could read out of a text node's words made one of the
 * mapper's own link nodes before the tree is written (ADR-0049, third attack
 * on PR #615). GFM reads addresses twice: in the source, as its syntax does
 * (escapes stop that), and in a text node's words once escapes are read
 * (`mdast-util-gfm-autolink-literal`'s transform, which nothing stops); and
 * the editor may write a line's words back without their escapes. So this
 * takes the wider of the two readings: an address after any character, a
 * scheme's with any domain, `www.` with a domain GFM takes, a mail address
 * with a dotted domain not ending in `-` or `_`; each cut as GFM cuts it. A
 * link more than GFM would make is only an address made a link; one fewer
 * would be a sender's words read as a link. Read by hand in one pass each:
 * GFM's own regular expressions retry from every character, quadratic on a
 * message of 40,000 letters.
 */

type Piece = MdText | MdLink;

/** The phrasing, its neighbouring words joined as GFM reads them, every address in them a link. */
export function linkifyPhrasing(nodes: readonly MdPhrasing[]): MdPhrasing[] {
  return joinedWords(nodes).flatMap((node): MdPhrasing[] => {
    if (node.type === 'text') return linkifyWords(node.value).pieces;
    if (node.type === 'strong' || node.type === 'emphasis' || node.type === 'delete') {
      return [{ ...node, children: linkifyPhrasing(node.children) }];
    }
    return [node];
  });
}

/** Text nodes side by side made one, as markdown reads them back. */
function joinedWords(nodes: readonly MdPhrasing[]): MdPhrasing[] {
  const joined: MdPhrasing[] = [];
  for (const node of nodes) {
    const last = joined.at(-1);
    if (node.type === 'text' && last?.type === 'text')
      joined[joined.length - 1] = text(last.value + node.value);
    else if (node.type !== 'text' || node.value !== '') joined.push(node);
  }
  return joined;
}

/** A text node's words with every address GFM would read made a link, and the work it took. */
export function linkifyWords(value: string): { pieces: Piece[]; steps: number } {
  const web = linkifyWeb(value);
  let steps = web.steps;
  const pieces = web.pieces.flatMap((piece) => {
    if (piece.type !== 'text') return [piece];
    const mail = linkifyMail(piece.value);
    steps += mail.steps;
    return mail.pieces;
  });
  return { pieces: pieces.filter((piece) => piece.type !== 'text' || piece.value !== ''), steps };
}

const isWordUnit = (unit: number) =>
  (unit >= 48 && unit <= 57) ||
  (unit >= 65 && unit <= 90) ||
  (unit >= 97 && unit <= 122) ||
  unit === 95;

/** For each place in the words, where the next space, tab or line ending is: an address's end. */
function pathEnds(value: string): Int32Array {
  const ends = new Int32Array(value.length + 1);
  ends[value.length] = value.length;
  for (let at = value.length - 1; at >= 0; at -= 1) {
    const unit = value.charCodeAt(at);
    const space = unit === 32 || unit === 9 || unit === 13 || unit === 10;
    ends[at] = space ? at : (ends[at + 1] ?? value.length);
  }
  return ends;
}

/** The protocol at `at`, by its length (`www.` 0), or null: `https?://` and `www.`, in any case. */
function protocolAt(value: string, at: number): number | null {
  const ahead = value.slice(at, at + 8).toLowerCase();
  if (ahead.startsWith('https://')) return 8;
  if (ahead.startsWith('http://')) return 7;
  return ahead.startsWith('www.') ? 0 : null;
}

const TRAIL = new Set(['!', '"', '&', "'", ')', ',', '.', ':', ';', '<', '>', '?', ']', '}']);

/** GFM's `splitUrl`: trailing punctuation off, but each `)` an unclosed `(` in the address needs kept. */
function splitUrl(url: string): [string, string] {
  let end = url.length;
  while (end > 0 && TRAIL.has(url[end - 1] ?? '')) end -= 1;
  let address = url.slice(0, end);
  let trail = url.slice(end);
  let opens = 0;
  let closes = 0;
  for (const character of address) {
    if (character === '(') opens += 1;
    else if (character === ')') closes += 1;
  }
  let close = trail.indexOf(')');
  while (close !== -1 && opens > closes) {
    address += trail.slice(0, close + 1);
    trail = trail.slice(close + 1);
    close = trail.indexOf(')');
    closes += 1;
  }
  return [address, trail];
}

/** GFM's address pass over one text node's words: `https?://…` and `www.…`. */
function linkifyWeb(value: string): { pieces: Piece[]; steps: number } {
  const pathEnd = pathEnds(value);
  const pieces: Piece[] = [];
  let steps = value.length;
  let from = 0;
  let at = 0;
  while (at < value.length) {
    steps += 1;
    const found = webAddressAt(value, at, pathEnd);
    if (found === null) {
      at += 1;
      continue;
    }
    pieces.push(text(value.slice(from, at)), link(found.url, found.label));
    if (found.trail !== '') pieces.push(text(found.trail));
    steps += found.end - at;
    from = found.end;
    at = found.end;
  }
  pieces.push(text(value.slice(from)));
  return { pieces, steps };
}

/**
 * The address read at `at`, with what is left after it and where its match
 * ends, or null: a scheme or `www.` and everything up to the next space, as
 * GFM's widest reading takes it — any domain, any characters beyond ASCII —
 * then cut as GFM cuts trailing punctuation.
 */
function webAddressAt(
  value: string,
  at: number,
  pathEnd: Int32Array,
): { url: string; label: string; trail: string; end: number } | null {
  const protocol = protocolAt(value, at);
  if (protocol === null) return null;
  const end = pathEnd[at] ?? value.length;
  const [address, trail] = splitUrl(value.slice(at + protocol, end));
  if (address === '') return null;
  const scheme = value.slice(at, at + protocol);
  return {
    url: `${protocol === 0 ? 'http://' : ''}${scheme}${address}`,
    label: `${scheme}${address}`,
    trail,
    end,
  };
}

const isMailNameUnit = (unit: number) =>
  isWordUnit(unit) || unit === 45 || unit === 46 || unit === 43;
const isLabelUnit = (unit: number) => isWordUnit(unit) || unit === 45;

/** GFM's mail pass over one text node's words: `name@domain.tld`. */
function linkifyMail(value: string): { pieces: Piece[]; steps: number } {
  const nameEnd = mailNameEnds(value);
  const domains = new Map<number, MailDomain>();
  const pieces: Piece[] = [];
  let steps = value.length;
  let from = 0;
  let at = 0;
  while (at < value.length) {
    steps += 1;
    const end = mailAt(value, { at, nameEnd, domains });
    if (end === null) {
      at += 1;
      continue;
    }
    steps += end - at;
    const address = value.slice(at, end);
    pieces.push(text(value.slice(from, at)), link(`mailto:${address}`, address));
    from = end;
    at = end;
  }
  pieces.push(text(value.slice(from)));
  for (const { scanned } of domains.values()) steps += scanned;
  return { pieces, steps };
}

/** Where a domain after an `@` ends (null for none), and how many characters reading it took. */
interface MailDomain {
  readonly end: number | null;
  readonly scanned: number;
}

/** For each place in the words, where the run of a mail name's `[-.\w+]` from there ends. */
function mailNameEnds(value: string): Int32Array {
  const ends = new Int32Array(value.length + 1);
  ends[value.length] = value.length;
  for (let at = value.length - 1; at >= 0; at -= 1) {
    ends[at] = isMailNameUnit(value.charCodeAt(at)) ? (ends[at + 1] ?? value.length) : at;
  }
  return ends;
}

/**
 * Where the mail address GFM reads from `at` ends, or null: a name from a
 * boundary, its whole run, then `@` and a domain. Each `@`'s domain is read
 * once, however many names in one run reach it.
 */
function mailAt(
  value: string,
  { at, nameEnd, domains }: { at: number; nameEnd: Int32Array; domains: Map<number, MailDomain> },
): number | null {
  const sign = nameEnd[at] ?? at;
  if (sign === at || value.charCodeAt(sign) !== 64) return null;
  if (!domains.has(sign)) domains.set(sign, domainEnd(value, sign + 1));
  return domains.get(sign)?.end ?? null;
}

/**
 * Where the domain after an `@` ends: `[-\w]+(?:\.[-\w]+)+`, longest, and
 * not ending in `-` or `_`, which neither of GFM's readings takes; null for none.
 */
function domainEnd(value: string, start: number): MailDomain {
  let end = start;
  while (end < value.length && isLabelUnit(value.charCodeAt(end))) end += 1;
  if (end === start) return { end: null, scanned: 1 };
  let parts = 0;
  while (value.charCodeAt(end) === 46 && isLabelUnit(value.charCodeAt(end + 1))) {
    end += 1;
    while (end < value.length && isLabelUnit(value.charCodeAt(end))) end += 1;
    parts += 1;
  }
  const last = value.charCodeAt(end - 1);
  const refused = last === 45 || last === 95;
  return { end: parts === 0 || refused ? null : end, scanned: end - start + 1 };
}
