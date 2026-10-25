import { wikiLinkTargetWith } from '../markdown/resolve-wikilink.ts';
import { formatWikiLink, linkBreakingCharacter } from '../markdown/wikilink.ts';
import type { VaultPath } from '../vault/vault-path.ts';

/**
 * The link a semantic hit cites, so an answer can point at the very words
 * (PLAN.md §11, "every AI item cites its source"): `[[Note#^id]]` for a block
 * with an id of its own (ADR-0022), else `[[Note#Heading]]` for the section it
 * sits in, else `[[Note]]`. A heading no link could name — one holding `#`,
 * `^`, `|` or a bracket — leaves just the note. No id is written to make one:
 * that happens only when a link to the block is accepted (ADR-0031).
 */
export function blockLink({
  path,
  anchor,
  heading,
  resolve,
}: {
  path: VaultPath;
  anchor: string | null;
  heading: string | null;
  /** How links find notes in this vault, for the shortest target that still opens `path`. */
  resolve: (target: string) => VaultPath | null;
}): string {
  const target = wikiLinkTargetWith(path, resolve);
  return formatWikiLink({ target, heading: fragmentOf(anchor, heading), alias: null });
}

function fragmentOf(anchor: string | null, heading: string | null): string | null {
  if (anchor !== null) return `#^${anchor}`;
  if (heading !== null && linkBreakingCharacter(heading) === null) return `#${heading}`;
  return null;
}
