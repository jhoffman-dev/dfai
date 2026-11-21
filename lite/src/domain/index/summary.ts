import { splitWikiLinks, wikiLinkLabel } from '../links/index.ts';

/** The longest summary, in characters; a longer sentence is cut with an ellipsis. */
export const MAX_SUMMARY_LENGTH = 200;

/** Lines that hold no prose: headings, rules and table rows. */
const NOT_PROSE = /^\s*(?:#{1,6}(?:\s|$)|[-*_]{3,}\s*$|\|)/;
const FENCE = /^\s*(?:```|~~~)/;
/** A line of tags alone, such as `#person #area/pay`: a label, not the note's first sentence. */
const TAGS_ONLY = /^\s*#[^\s#]+(?:\s+#[^\s#]+)*\s*$/;
/** A list item or quote starts its own paragraph: it is never a soft-wrapped line of the one before. */
const NEW_BLOCK = /^\s*(?:[-*+]\s|\d+[.)]\s|>)/;

/**
 * A note's first sentence, as the index and previews show it (the vault
 * contract asks every note to start with one): the first paragraph of prose
 * outside code, its soft-wrapped lines joined, with list and quote markers,
 * emphasis and link brackets taken off, up to its first `.`, `!` or `?`
 * followed by a space or the end. A line of tags alone is passed over,
 * unless it is all the prose there is. Empty when the note has none.
 */
export function noteSummary(text: string): string {
  const paragraph = firstParagraph(text);
  if (paragraph === null) return '';
  const plain = paragraph.map(plainText).join(' ');
  const sentence = /^.*?[.!?](?=\s|$)/.exec(plain)?.[0] ?? plain;
  return sentence.length > MAX_SUMMARY_LENGTH
    ? `${sentence.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd()}…`
    : sentence;
}

const isProse = (line: string) => line.trim() !== '' && !NOT_PROSE.test(line) && !FENCE.test(line);

/** The lines of the first paragraph of prose, or the first tags line when there is no other. */
function firstParagraph(text: string): string[] | null {
  const lines = text.split(/\r?\n/);
  let inFence = false;
  let tagsLine: string | null = null;
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] as string;
    if (FENCE.test(line)) inFence = !inFence;
    if (inFence || !isProse(line)) continue;
    if (TAGS_ONLY.test(line)) {
      tagsLine ??= line;
      continue;
    }
    return [line, ...wrappedLines(lines, at + 1)];
  }
  return tagsLine === null ? null : [tagsLine];
}

/** The soft-wrapped lines that continue a paragraph, from `from` on. */
function wrappedLines(lines: readonly string[], from: number): string[] {
  const wrapped: string[] = [];
  for (const line of lines.slice(from)) {
    if (!isProse(line) || NEW_BLOCK.test(line) || TAGS_ONLY.test(line)) break;
    wrapped.push(line);
  }
  return wrapped;
}

function plainText(line: string): string {
  const unlinked = splitWikiLinks(line)
    .map((piece) => (piece.kind === 'text' ? piece.value : wikiLinkLabel(piece)))
    .join('');
  return unlinked
    .replace(/^\s*(?:>\s*)*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|`)(.+?)\1/g, '$2')
    .trim();
}
