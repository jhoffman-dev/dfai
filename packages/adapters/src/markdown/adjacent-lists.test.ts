import { describe, expect, it } from 'vitest';
import type { EditorDocument } from '@dfai/domain';
import { parseMarkdownBody, serializeMarkdownBody } from './markdown-blocks.ts';

/*
 * Two lists that come to stand side by side when the block between them is
 * moved or deleted (#569) are one list to markdown unless their markers
 * differ (ADR-0003, addendum). The list after is written again with other
 * markers; the one before keeps its bytes. Fictional data only.
 */

/** The note with its block at `from` moved to `to`, as a handle's move does. */
function moved(body: string, from: number, to: number): { saved: string; reread: string[] } {
  const parsed = parseMarkdownBody(body);
  const content = [...parsed.doc.content];
  const [block] = content.splice(from, 1);
  content.splice(to, 0, block!);
  const doc: EditorDocument = { type: 'doc', content };
  const saved = serializeMarkdownBody({ originalBody: body, parsed, doc });
  return { saved, reread: parseMarkdownBody(saved).doc.content.map((node) => node.type) };
}

describe('two bullet lists brought side by side', () => {
  const BODY = '- Water the ferns.\n- Mist them.\n\nBetween.\n\n- Repot the moss.\n';

  it('read back as two lists, the first in its own bytes and the second with the other bullet', () => {
    const { saved, reread } = moved(BODY, 1, 2);
    expect(reread).toEqual(['bulletList', 'bulletList', 'paragraph']);
    expect(saved).toBe('- Water the ferns.\n- Mist them.\n\n* Repot the moss.\n\nBetween.\n');
  });

  it('read back as a task list and a bullet list, which share a bullet', () => {
    const { reread } = moved('- [ ] Repot.\n\nBetween.\n\n- Water.\n', 1, 2);
    expect(reread).toEqual(['taskList', 'bulletList', 'paragraph']);
  });

  it('are left as they are when an id on its own line already keeps them apart', () => {
    const body = '- Water.\n\n^lst001\n\nBetween.\n\n- Repot.\n';
    const { saved, reread } = moved(body, 1, 2);
    expect(reread).toEqual(['bulletList', 'bulletList', 'paragraph']);
    expect(saved).toBe('- Water.\n\n^lst001\n\n- Repot.\n\nBetween.\n');
  });
});

describe('numbered lists brought side by side', () => {
  it('give the second the other delimiter', () => {
    const { saved, reread } = moved('1. Sow.\n\nBetween.\n\n1. Water.\n', 1, 2);
    expect(reread).toEqual(['orderedList', 'orderedList', 'paragraph']);
    expect(saved).toBe('1. Sow.\n\n1) Water.\n\nBetween.\n');
  });

  it('three in a row, with both delimiters already used, are still three lists', () => {
    // The block between the first two moved to the end: `.`, `.`, `)` stand together.
    const body = '1. Sow.\n\nBetween.\n\n1. Water.\n\n1) Weed.\n';
    const { saved, reread } = moved(body, 1, 3);
    expect(reread).toEqual(['orderedList', 'orderedList', 'orderedList', 'paragraph']);
    expect(saved).toBe('1. Sow.\n\n1) Water.\n\n1. Weed.\n\nBetween.\n');
  });
});

describe('a list that comes to stand after a paragraph', () => {
  it('keeps its bytes: nothing joins it', () => {
    const body = '- Water.\n\nBetween.\n\n- Repot.\n';
    const { saved } = moved(body, 0, 1);
    expect(saved).toBe('Between.\n\n- Water.\n\n* Repot.\n');
  });
});
