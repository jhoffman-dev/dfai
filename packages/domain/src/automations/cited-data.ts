/**
 * Data a Claude step is handed with each item's note (#40, #39): the lines of
 * a section, each linking the note it is about, and the notes the step's
 * answer may then cite (`cited-items.ts`). Values from notes are flattened
 * first, so vault text can neither start another item nor link a note of its
 * own choosing.
 */

import { linkBreakingCharacter } from '../markdown/wikilink.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import type { PromptData } from './proposal-schema.ts';

/** The data a step is handed, and the notes it may cite. */
export interface CitedStepData {
  readonly data: readonly PromptData[];
  /**
   * What a list item may link to be taken as citing: a note's path, or — for a
   * note whose name no link can hold — the id handed in its place (`src:3`).
   */
  readonly sources: readonly string[];
  /** For each such id, the note's title, which the answer shows where the id was. */
  readonly plain: ReadonlyMap<string, string>;
}

/** A note a section lists, and what is said about it. */
export interface CitedLine {
  readonly note: { readonly path: VaultPath; readonly title: string };
  readonly detail: string;
}

/**
 * How each note is cited: by its path, or by an id when no link could hold
 * its path. One note has one citation wherever it is listed.
 */
export class Citations {
  private readonly byPath = new Map<string, string>();
  readonly plain = new Map<string, string>();

  get sources(): string[] {
    return [...this.byPath.values()];
  }

  /** What a link to the note is written with. */
  targetOf({ path, title }: { path: VaultPath; title: string }): string {
    const known = this.byPath.get(path);
    if (known !== undefined) return known;
    const target = linkBreakingCharacter(path) === null ? path : `src:${this.byPath.size + 1}`;
    this.byPath.set(path, target);
    if (target !== path) this.plain.set(target, flattened(title));
    return target;
  }
}

/**
 * A value from a note on one line, as plain words: whitespace of any kind is
 * one space, and every run of brackets is broken — `[[[` too, not just its
 * first pair — so a name or title cannot start another list item or link a
 * note of its own choosing.
 */
export function flattened(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\[(?=\[)/g, '[ ')
    .replace(/\](?=\])/g, '] ')
    .trim();
}

/** "- [[Tasks/Send the file.md]] Send the file — due 2026-10-20". */
function lineOf({ note, detail }: CitedLine, target: string): string {
  const after = detail === '' ? '' : ` — ${flattened(detail)}`;
  return `- [[${target}]] ${flattened(note.title)}${after}`;
}

/**
 * A section of the data: its lines, each linking its note, at most `limit` of
 * them and a count of the rest; "None." when it lists nothing.
 */
export function citedSection({
  about,
  lines,
  limit,
  citations,
}: {
  about: string;
  lines: readonly CitedLine[];
  limit: number;
  citations: Citations;
}): PromptData {
  const shown = lines.slice(0, limit);
  const more = Math.max(0, lines.length - limit);
  const text =
    shown.length === 0
      ? ['None.']
      : shown.map((line) => lineOf(line, citations.targetOf(line.note)));
  return { about, text: [...text, ...(more > 0 ? [`And ${more} more.`] : [])].join('\n') };
}
