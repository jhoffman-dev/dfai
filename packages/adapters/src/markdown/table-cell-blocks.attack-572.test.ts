import { describe, expect, it } from 'vitest';
import type { EditorNode } from '@dfai/domain';
import { remarkMarkdown } from './markdown-port.ts';
import { UnsupportedNodeError } from './editor-to-mdast.ts';

/*
 * Attack on PR #572 (#569): the block handle drags any block — a highlight, a
 * raw HTML block, a list — and ProseMirror's drop puts it where the schema
 * lets it, which a table cell does (`block+`). A markdown cell is one line.
 * A raw block in a cell is written as nothing: the save drops it, with no
 * error, and a highlight goes with no tombstone. A save may refuse a note it
 * cannot write, loudly; it may never drop a block quietly. Fictional data.
 */

const HIGHLIGHT = [
  '> Larkspur fern passage.',
  '> <!-- atlas:highlight {"v":1,"mark":"highlight","color":"yellow","kind":"pdf","page":3} -->',
  '>',
  '> Comment for Mara Quill. ^fern01',
].join('\n');

const BODY = `| Bed | Plant |\n| - | - |\n| North | Fern |\n\n${HIGHLIGHT}\n\n<div class="larkspur">Tobias Fenn</div>\n\nAfter.\n`;

/** The note's body with its block of type `type` moved into the table's first body cell, as a drop puts it. */
function savedWithBlockInCell(type: string, which: (node: EditorNode) => boolean): string {
  const parsed = remarkMarkdown.parseBody(BODY);
  const doc = structuredClone(parsed.doc) as unknown as { content: EditorNode[] };
  const at = doc.content.findIndex((node) => node.type === type && which(node));
  if (at === -1) throw new Error(`No ${type} block.`);
  const [moved] = doc.content.splice(at, 1);
  const table = doc.content[0] as unknown as {
    content: { content: { content: EditorNode[] }[] }[];
  };
  table.content[1]!.content[0]!.content.push(moved!);
  return remarkMarkdown.serializeBody({ originalBody: BODY, parsed, doc: doc as never });
}

/** What a save writes, or that it refused: a refusal is loud, which is allowed. */
function writtenOrRefused(save: () => string): string | 'refused' {
  try {
    return save();
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedNodeError);
    return 'refused';
  }
}

describe('a block dropped into a table cell, saved', () => {
  it('a highlight in a cell is written or refused, never dropped silently', () => {
    const written = writtenOrRefused(() =>
      savedWithBlockInCell('rawBlock', (node) =>
        String(node.attrs?.['markdown']).includes('atlas:highlight'),
      ),
    );
    if (written !== 'refused') expect(written).toContain('atlas:highlight');
  });

  it('a raw HTML block in a cell is written or refused, never dropped silently', () => {
    const written = writtenOrRefused(() =>
      savedWithBlockInCell('rawBlock', (node) =>
        String(node.attrs?.['markdown']).includes('larkspur'),
      ),
    );
    if (written !== 'refused') expect(written).toContain('Tobias Fenn');
  });
});
