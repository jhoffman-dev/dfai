import type { VaultIndex } from '../index/index.ts';
import { isConflictCopyPath } from '../sync/index.ts';
import { findTags } from '../tags/index.ts';
import { noteTitle, type VaultPath } from '../vault/index.ts';
import { MAX_LINE_SUMMARY, cappedList, linkTo, truncated } from './text.ts';

const MAX_LINKS_OUT = 8;
const MAX_BACKLINK_NAMES = 3;

/** How a folder index line reads, said once at the top of each folder file. */
export const NOTE_LINE_FORMAT =
  'Line: path | #tags | → links out | ← N: first linking notes | ! conflict copy | first sentence. Empty parts are left out; +N = N more.';

/** One note as its folder index shows it. */
export function noteLine(index: VaultIndex, path: VaultPath): string {
  const parts = [path];
  const tags = index.tagsOf(path).map(({ name }) => `#${name}`);
  if (tags.length > 0) parts.push(tags.join(' '));
  const out = linksOut(index, path);
  if (out.length > 0) parts.push(`→ ${cappedList(out.map(linkTo), MAX_LINKS_OUT)}`);
  const backlinks = index.backlinks(path);
  if (backlinks.length > 0) {
    const names = backlinks.slice(0, MAX_BACKLINK_NAMES).map((from) => linkTo(noteTitle(from)));
    parts.push(`← ${backlinks.length}: ${names.join(' ')}`);
  }
  if (isConflictCopyPath(path)) parts.push('! conflict copy');
  const summary = lineSummary(index.summary(path));
  if (summary !== '') parts.push(summary);
  return parts.join(' | ');
}

/** The notes a note links to, each once, in the order written: a title, or the target as written. */
function linksOut(index: VaultIndex, path: VaultPath): string[] {
  const names = new Set<string>();
  for (const link of index.outgoing(path)) {
    if (link.resolved === path) continue;
    names.add(link.resolved === null ? link.target.trim() : noteTitle(link.resolved));
  }
  return [...names];
}

/** A first sentence without its inline tags (the line lists them) and short enough to scan. */
export function lineSummary(summary: string): string {
  let plain = summary;
  for (const tag of [...findTags(summary)].reverse()) {
    plain = `${plain.slice(0, tag.start)}${plain.slice(tag.end)}`;
  }
  const tidy = plain
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
  return truncated(tidy, MAX_LINE_SUMMARY);
}
