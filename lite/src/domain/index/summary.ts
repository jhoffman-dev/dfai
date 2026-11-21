import { splitWikiLinks, wikiLinkLabel } from '../links/index.ts';

/** The longest summary, in characters; a longer sentence is cut with an ellipsis. */
export const MAX_SUMMARY_LENGTH = 200;

/** Lines that hold no prose: headings, rules and table rows. */
const NOT_PROSE = /^\s*(?:#{1,6}(?:\s|$)|[-*_]{3,}\s*$|\|)/;
const FENCE = /^\s*(?:```|~~~)/;

/**
 * A note's first sentence, as the index and previews show it (the vault
 * contract asks every note to start with one): the first line of prose
 * outside code, with list and quote markers, emphasis and link brackets taken
 * off, up to its first `.`, `!` or `?` followed by a space or the end. Empty
 * when the note has no prose.
 */
export function noteSummary(text: string): string {
  const line = firstProseLine(text);
  if (line === null) return '';
  const plain = plainText(line);
  const sentence = /^.*?[.!?](?=\s|$)/.exec(plain)?.[0] ?? plain;
  return sentence.length > MAX_SUMMARY_LENGTH
    ? `${sentence.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd()}…`
    : sentence;
}

function firstProseLine(text: string): string | null {
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) inFence = !inFence;
    else if (!inFence && line.trim() !== '' && !NOT_PROSE.test(line)) return line;
  }
  return null;
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
