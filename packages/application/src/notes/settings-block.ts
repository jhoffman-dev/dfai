import { isBlankFrontmatter, opensUnclosedFrontmatter, splitFrontmatter } from '@dfai/domain';
import type { MarkdownPort } from './ports.ts';

/**
 * The properties of a file whose settings are its frontmatter — a rule, a type —
 * or why its frontmatter gives none. Each of these reads as no properties, so
 * the file cannot say what it is: in its folder it most likely is one, and
 * leaving it out drops it silently (#679, #683). A file with no block, or a
 * blank one, has nothing to say and is not a problem.
 */
export function readSettingsBlock(
  markdown: Pick<MarkdownPort, 'frontmatterProblem' | 'frontmatterProperties'>,
  text: string,
): { properties: Readonly<Record<string, unknown>> } | { problem: string } {
  if (opensUnclosedFrontmatter(text)) return { problem: 'Its frontmatter has no closing ---.' };
  const block = splitFrontmatter(text).frontmatter;
  const reason = markdown.frontmatterProblem(block);
  if (reason !== null) return { problem: `Its frontmatter is not valid YAML: ${reason}` };
  const properties = markdown.frontmatterProperties(block);
  // YAML that reads as a list or one value: as Confluence export tells it, not the port,
  // which reads such a block as none and is right to for every other note.
  if (block !== null && !isBlankFrontmatter(block) && Object.keys(properties).length === 0) {
    return { problem: 'Its frontmatter is not a set of properties.' };
  }
  return { properties };
}
