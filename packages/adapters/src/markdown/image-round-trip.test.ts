import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  relativeImageSource,
  resolveImageSource,
  type EditorDocument,
  type EditorNode,
} from '@dfai/domain';
import { parseMarkdownBody, renderBlock, serializeMarkdownBody } from './markdown-blocks.ts';

/** The ways a note written elsewhere — Obsidian, an editor, by hand — puts in an image. */
const IMAGE_LINES: Array<[label: string, markdown: string]> = [
  ['Obsidian markdown-link paste', '![](Pasted%20image%2020230101093012.png)'],
  ['relative, climbing', '![A chart](../attachments/Q3%20chart.png)'],
  ['angle-bracket destination with a space', '![alt](<attachments/my image.png>)'],
  ['with a title', '![alt](a.png "The title")'],
  ['Obsidian size in the alt text', '![diagram|300](diagram.png)'],
  ['Obsidian wiki embed', '![[Pasted image 20230101093012.png]]'],
  ['external', '![logo](https://example.com/logo.svg)'],
  ['HTML image', '<img src="a.png" width="200">'],
  ['reference-style', '![alt][pic]\n\n[pic]: attachments/pic.png'],
  ['several on a line with text', 'Before ![a](a.png) between ![b](b%20c.png) after'],
  ['linked to a page', '[![logo](logo.png)](https://example.com)'],
];

const body = (line: string) => `# Photos\n\n${line}\n\nSome text after.\n`;

describe('a note with images, saved after editing something else', () => {
  it.each(IMAGE_LINES)('keeps a %s byte-identical', (_label, line) => {
    const original = body(line);
    const parsed = parseMarkdownBody(original);
    const content = [...parsed.doc.content];
    const last = content.length - 1;
    content[last] = { ...content[last]!, content: [{ type: 'text', text: 'Edited.' }] };

    const saved = serializeMarkdownBody({
      originalBody: original,
      parsed,
      doc: { type: 'doc', content },
    });

    expect(saved).toBe(`# Photos\n\n${line}\n\nEdited.\n`);
  });

  it.each(IMAGE_LINES)('keeps a %s byte-identical when nothing is edited', (_label, line) => {
    const original = body(line);
    const parsed = parseMarkdownBody(original);
    expect(serializeMarkdownBody({ originalBody: original, parsed, doc: parsed.doc })).toBe(
      original,
    );
  });
});

describe('an image inside a link', () => {
  it('keeps its link when the words beside it are edited', () => {
    const original = 'See [![logo](logo.png)](https://example.com) here.\n';
    const parsed = parseMarkdownBody(original);
    const [paragraph] = parsed.doc.content;
    const content = (paragraph?.content ?? []).map((node) =>
      node.type === 'text' && node.text === ' here.' ? { ...node, text: ' there.' } : node,
    );
    const doc: EditorDocument = { type: 'doc', content: [{ ...paragraph!, content }] };

    expect(serializeMarkdownBody({ originalBody: original, parsed, doc })).toBe(
      'See [![logo](logo.png)](https://example.com) there.\n',
    );
  });
});

/** Adds a paragraph holding one image to the end of `original`, as the editor does on a paste. */
function withImageAdded(original: string, image: { src: string; alt: string }): string {
  const parsed = parseMarkdownBody(original);
  const added: EditorNode = {
    type: 'paragraph',
    content: [{ type: 'image', attrs: { src: image.src, alt: image.alt, title: null } }],
  };
  const doc: EditorDocument = { type: 'doc', content: [...parsed.doc.content, added] };
  return serializeMarkdownBody({ originalBody: original, parsed, doc });
}

describe('an embedded image, as it is written into the note', () => {
  const notePath = createVaultPath('Work/Plans/q3.md');
  const imagePath = createVaultPath('attachments/Pasted image 20260925143012.png');
  const src = relativeImageSource({ notePath, imagePath });

  it('is a standard markdown image with a relative, percent-encoded path', () => {
    const saved = withImageAdded('Intro.\n', { src, alt: '' });
    expect(saved).toBe('Intro.\n\n![](../../attachments/Pasted%20image%2020260925143012.png)\n');
  });

  it('keeps its alt text, escaped where markdown needs it', () => {
    const saved = withImageAdded('', { src: 'a.png', alt: 'a [bracketed] word' });
    expect(saved).toBe('![a \\[bracketed\\] word](a.png)\n');
    const reparsed = parseMarkdownBody(saved).doc.content[0]?.content?.[0];
    expect(reparsed?.attrs?.['alt']).toBe('a [bracketed] word');
  });

  it('reads back to the same destination, which resolves to the saved file', () => {
    const saved = withImageAdded('Intro.\n', { src, alt: 'shot' });
    const node = parseMarkdownBody(saved).doc.content[1]?.content?.[0];
    expect(node).toEqual({ type: 'image', attrs: { src, alt: 'shot', title: null } });
    expect(resolveImageSource({ src: String(node?.attrs?.['src']), notePath })).toEqual({
      kind: 'vault',
      path: imagePath,
    });
  });

  it('keeps an angle-bracket destination readable when its alt text is edited', () => {
    const { doc } = parseMarkdownBody('![old](<attachments/my image.png>)\n');
    const paragraph = doc.content[0]!;
    const image = paragraph.content![0]!;
    const edited = { ...paragraph, content: [{ ...image, attrs: { ...image.attrs, alt: 'new' } }] };
    expect(renderBlock(edited)).toBe('![new](<attachments/my image.png>)');
  });
});

/** `line` with ` more` typed at the end of its paragraph, as saved. */
function typedAfter(line: string): string {
  const original = `${line}\n`;
  const parsed = parseMarkdownBody(original);
  const paragraph = parsed.doc.content[0]!;
  const edited: EditorNode = {
    ...paragraph,
    content: [...(paragraph.content ?? []), { type: 'text', text: ' more' }],
  };
  return serializeMarkdownBody({
    originalBody: original,
    parsed,
    doc: { type: 'doc', content: [edited] },
  });
}

describe('an Obsidian image embed in a paragraph that is edited', () => {
  it.each([
    ['a lone embed', '![[Pasted image 20230101093012.png]]'],
    ['an embed with a size', '![[diagram.png|300]]'],
    ['an embed after text', 'See ![[chart.png]]'],
  ])('writes %s back as an embed, its `!` unescaped', (_label, line) => {
    expect(typedAfter(line)).toBe(`${line} more\n`);
  });
});

describe('an image in a paragraph that is edited around it', () => {
  it.each([
    ['a title in single quotes', "See ![alt](a.png 't')"],
    ['a title in parentheses', 'See ![alt](a.png (t))'],
    ['parentheses in the path', 'See ![alt](a(1).png)'],
    ['an ampersand', 'See ![R&D](r&d.png)'],
    ['emphasis in the alt text', 'See ![a *b* c](x.png)'],
    ['two images that read the same, written differently', '![a](x.png \'t\') ![a](x.png "t")'],
  ])('keeps an image with %s byte-identical', (_label, line) => {
    expect(typedAfter(line)).toBe(`${line} more\n`);
  });

  it('writes an image whose alt text was edited from what it now holds', () => {
    const original = "See ![old](a(1).png 't')\n";
    const parsed = parseMarkdownBody(original);
    const paragraph = parsed.doc.content[0]!;
    const content = (paragraph.content ?? []).map((node) =>
      node.type === 'image' ? { ...node, attrs: { ...node.attrs, alt: 'new' } } : node,
    );
    const saved = serializeMarkdownBody({
      originalBody: original,
      parsed,
      doc: { type: 'doc', content: [{ ...paragraph, content }] },
    });
    expect(saved).toBe('See ![new](a\\(1\\).png "t")\n');
  });
});

/** `original` with each image in it resized to `width` (its natural size when null), as saved. */
function resized(original: string, width: number | null): string {
  const parsed = parseMarkdownBody(original);
  const content = parsed.doc.content.map((block) => ({
    ...block,
    ...(block.content !== undefined && {
      content: block.content.map((node) =>
        node.type === 'image' ? { ...node, attrs: { ...node.attrs, width, height: null } } : node,
      ),
    }),
  }));
  return serializeMarkdownBody({ originalBody: original, parsed, doc: { type: 'doc', content } });
}

describe('an image’s size on the page (#568)', () => {
  it.each([
    ['a width', '![diagram|300](diagram.png)', { alt: 'diagram', width: 300, height: null }],
    [
      'a width and height',
      '![diagram|400x300](d.png)',
      { alt: 'diagram', width: 400, height: 300 },
    ],
    ['no alt text', '![|250](d.png)', { alt: '', width: 250, height: null }],
    [
      'a pipe in the alt text',
      '![in | out|120](d.png)',
      { alt: 'in | out', width: 120, height: null },
    ],
  ])('reads %s out of the alt text', (_label, line, attrs) => {
    const node = parseMarkdownBody(`${line}\n`).doc.content[0]?.content?.[0];
    expect(node?.attrs).toMatchObject(attrs);
  });

  it('reads an image with no size as before: no size attributes at all', () => {
    const node = parseMarkdownBody('![a|b](d.png)\n').doc.content[0]?.content?.[0];
    expect(node).toEqual({ type: 'image', attrs: { src: 'd.png', alt: 'a|b', title: null } });
  });

  it.each([
    ['a width', '![shot|300](a.png)', '![shot|480](a.png)'],
    ['no size yet', '![shot](a.png)', '![shot|480](a.png)'],
    ['no alt text', '![](a.png)', '![|480](a.png)'],
    ['a width and a height', '![shot|400x300](a.png)', '![shot|480](a.png)'],
    [
      'an angle-bracket path and a single-quoted title',
      "![a \\[b\\]|300](<my pic.png> 't')",
      "![a \\[b\\]|480](<my pic.png> 't')",
    ],
    ['a pipe in the words', '![in | out](a.png)', '![in | out|480](a.png)'],
    ['text beside it', 'See ![shot|300](a(1).png) here', 'See ![shot|480](a(1).png) here'],
  ])('changes only the width token of an image with %s', (_label, line, saved) => {
    expect(resized(`# Photos\n\n${line}\n\nAfter.\n`, 480)).toBe(
      `# Photos\n\n${saved}\n\nAfter.\n`,
    );
  });

  it('takes the width token out when the image goes back to its natural size', () => {
    expect(resized("![shot|300](<my pic.png> 't')\n", null)).toBe("![shot](<my pic.png> 't')\n");
  });

  it('keeps a width and height byte-identical when other words in its paragraph are edited', () => {
    expect(typedAfter('See ![chart|400x300](<my chart.png>)')).toBe(
      'See ![chart|400x300](<my chart.png>) more\n',
    );
  });

  it('writes a new sized image as Obsidian does', () => {
    const doc: EditorDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'image', attrs: { src: 'a.png', alt: 'shot', title: null, width: 320 } },
          ],
        },
      ],
    };
    expect(serializeMarkdownBody({ originalBody: '', parsed: parseMarkdownBody(''), doc })).toBe(
      '![shot|320](a.png)\n',
    );
  });

  it('leaves a sized Obsidian embed alone: its `|300` is the embed’s own', () => {
    const node = parseMarkdownBody('![[diagram.png|300]]\n').doc.content[0]?.content?.[0];
    expect(node).toMatchObject({
      type: 'wikiLink',
      attrs: { target: 'diagram.png', alias: '300' },
    });
    expect(typedAfter('![[diagram.png|300]]')).toBe('![[diagram.png|300]] more\n');
  });
});

/** `node` with `change` applied to every image in it. */
function withImages(node: EditorNode, change: (image: EditorNode) => EditorNode): EditorNode {
  if (node.type === 'image') return change(node);
  if (node.content === undefined) return node;
  return { ...node, content: node.content.map((child) => withImages(child, change)) };
}

function firstImage(node: EditorNode): Record<string, unknown> | undefined {
  if (node.type === 'image') return node.attrs;
  for (const child of node.content ?? []) {
    const found = firstImage(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

describe('an image written afresh, where the words meet the size (#568)', () => {
  const TABLE = '| Photo | Notes |\n| - | - |\n| ![shot](a.png) | kept |\n';

  /** The table with its image changed, written whole: nothing of it is kept from the original. */
  const tableWritten = (change: (image: EditorNode) => EditorNode): string => {
    const doc = withImages(parseMarkdownBody(TABLE).doc as EditorNode, change) as EditorDocument;
    return serializeMarkdownBody({ originalBody: '', parsed: parseMarkdownBody(''), doc });
  };

  it('in a table cell, writes the size with its pipe escaped, and the table stays a table', () => {
    const saved = tableWritten((image) => ({
      ...image,
      attrs: { ...image.attrs, width: 480, height: null },
    }));
    expect(saved).toContain('| ![shot\\|480](a.png) |');
    const read = parseMarkdownBody(saved).doc;
    expect(read.content[0]?.type).toBe('table');
    expect(firstImage(read as EditorNode)).toEqual({
      src: 'a.png',
      alt: 'shot',
      title: null,
      width: 480,
      height: null,
    });
  });

  it('in a table cell, keeps alt text that ends like a size as words', () => {
    const saved = tableWritten((image) => ({
      ...image,
      attrs: { ...image.attrs, alt: 'Route 66|2024' },
    }));
    const read = parseMarkdownBody(saved).doc;
    expect(read.content[0]?.type).toBe('table');
    expect(firstImage(read as EditorNode)).toEqual({
      src: 'a.png',
      alt: 'Route 66|2024',
      title: null,
    });
  });

  it('in a paragraph, escapes the pipe of alt text that ends like a size', () => {
    const doc: EditorDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'image', attrs: { src: 'a.png', alt: 'Route 66|2024', title: null } }],
        },
      ],
    };
    expect(serializeMarkdownBody({ originalBody: '', parsed: parseMarkdownBody(''), doc })).toBe(
      '![Route 66\\|2024](a.png)\n',
    );
  });
});
