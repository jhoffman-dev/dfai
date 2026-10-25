import { describe, expect, it } from 'vitest';
import type { EditorDocument, EditorNode } from '@dfai/domain';
import { parseMarkdownBody, serializeMarkdownBody } from './markdown-blocks.ts';
import { generatedDocument } from './writer-fuzz.test-support.ts';

/*
 * Attack on PR #572 (#569): the block handle's move and delete act on the
 * note's top-level blocks. Over seeded hostile notes, a run of random moves
 * and deletes is saved, and (ADR-0003) every block it did not touch is
 * written back in its own bytes, and the file reads back as the note the
 * person sees. Fictional data only.
 */

const SEEDS = 300;
const STEPS = 6;

const HOSTILE = [
  '---\ntitle: Larkspur beds\ntags: [fern]\n---',
  '## North bed ^bed001',
  '1. Sow.\n2. Water.\n   - Twice a week.',
  '- [ ] Repot the fern for Mara Quill.\n- [x] Order moss.',
  '> [!note] Callout\n> Tobias Fenn keeps the key.',
  '| Bed | Plant |\n| - | - |\n| North | Fern |',
  'A fern ![fern](fern.png) by the wall.',
  '<div class="larkspur">Raw block</div>',
  '> Larkspur fern passage.\n> <!-- atlas:highlight {"v":1,"mark":"highlight","color":"yellow","kind":"pdf","page":3} -->\n>\n> Comment for Mara Quill. ^hl0001',
  '<!-- atlas:highlight-removed {"v":1,"kind":"kindle","location":9,"annotationId":"A9","words":"3f2a"} -->',
  '![[Brightwater#^hl0001]]',
  'Plain words. ^par001',
];

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A hostile note as it sits on disk: some of the fixed blocks, then a generated note's. */
function noteOnDisk(seed: number, random: () => number): string {
  const generated = serializeMarkdownBody({
    originalBody: '',
    parsed: parseMarkdownBody(''),
    doc: generatedDocument(seed),
  });
  // Frontmatter is the body's business elsewhere: here the body's blocks only.
  const fixed = HOSTILE.slice(1).filter(() => random() < 0.5);
  return `${[...fixed, generated.trimEnd()].join('\n\n')}\n`;
}

/** The note with a random run of moves (one block past its neighbour) and deletes of its top-level blocks. */
function edited(doc: EditorDocument, random: () => number): EditorDocument {
  const content = [...doc.content];
  for (let step = 0; step < STEPS && content.length > 1; step += 1) {
    const at = Math.floor(random() * content.length);
    if (random() < 0.25) {
      content.splice(at, 1);
    } else {
      const to = random() < 0.5 ? at - 1 : at + 1;
      if (to < 0 || to >= content.length) continue;
      [content[at], content[to]] = [content[to]!, content[at]!];
    }
  }
  return { type: 'doc', content };
}

/** A node without the reader's own block ids, which a re-read numbers afresh. */
function withoutReadIds(node: EditorNode): unknown {
  const { attrs, content, ...rest } = node;
  const kept = attrs === undefined ? undefined : { ...attrs, blockId: undefined };
  return { ...rest, attrs: kept, content: content?.map(withoutReadIds) };
}

/** The marker a block's first line is an item with (a bullet, or a number's delimiter), or null. */
function firstMarker(source: string): string | null {
  const first = source.split(/\r?\n/, 1)[0] ?? '';
  if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(first)) return null;
  const match = /^ {0,3}(?:\d{1,9}([.)])|([-*+]))(?:[ \t]|$)/.exec(first);
  return match === null ? null : (match[2] ?? match[1] ?? null);
}

const LEADING_MARKER = /^( *)(?:(\d{1,9})[.)]|[-*+])(?=[ \t]|$)/gm;

/**
 * Text with every line-leading list marker — a bullet, or a number's delimiter,
 * the number kept — made one, and nothing else changed, so that only a
 * re-marking is forgiven: an escape dropped, a space moved, is caught.
 */
const withMarkersBlanked = (text: string): string => text.replace(LEADING_MARKER, '$1$2#');

/**
 * The one block allowed to differ from its bytes (ADR-0003 addendum): the later
 * of two neighbouring lists that would read as one, which the save re-marks on
 * purpose. Exempt only when the block before it in the note shown is an
 * untouched list with the same first marker, and the bytes `written` for it are
 * its own except for the list marker characters. (A list kept apart by an id
 * line keeps its bytes, so it never needs the exemption.)
 */
function isDeliberatelyRemarked({
  shown,
  at,
  parsedBlocks,
  written,
}: {
  shown: readonly EditorNode[];
  at: number;
  parsedBlocks: ReturnType<typeof parseMarkdownBody>['blocks'];
  written: string;
}): boolean {
  const blockAt = (index: number) =>
    parsedBlocks.find((block) => block.id === shown[index]?.attrs?.['blockId']);
  const block = blockAt(at);
  const before = at === 0 ? undefined : blockAt(at - 1);
  if (block === undefined || before === undefined) return false;
  const marker = firstMarker(block.source);
  if (marker === null || marker !== firstMarker(before.source)) return false;
  return withMarkersBlanked(written) === withMarkersBlanked(block.source);
}

/**
 * The byte clause (ADR-0003): every block of `doc` the person did not touch
 * stands in the saved note in exactly its own bytes. The saved note is split
 * into blocks and each untouched block is compared with the span at its
 * place, so a byte appended to a block is caught, not only one taken away.
 */
function untouchedBytesLost({
  parsed,
  doc,
  saved,
}: {
  parsed: ReturnType<typeof parseMarkdownBody>;
  doc: EditorDocument;
  saved: string;
}): string[] {
  const spans = parseMarkdownBody(saved).blocks;
  const lost: string[] = [];
  for (const [at, node] of doc.content.entries()) {
    const source = parsed.blocks.find((block) => block.id === node.attrs?.['blockId'])?.source;
    if (source === undefined) continue;
    const span = spans[at];
    const written = span === undefined ? '' : saved.slice(span.start, span.end);
    if (written === source) continue;
    const remarked = isDeliberatelyRemarked({
      shown: doc.content,
      at,
      parsedBlocks: parsed.blocks,
      written,
    });
    if (!remarked) {
      lost.push(
        `untouched block lost its bytes: ${JSON.stringify(source)} is written ${JSON.stringify(written)}`,
      );
    }
  }
  return lost;
}

describe('moves and deletes of top-level blocks, saved', () => {
  it(`keep every untouched block's bytes and read back as shown, over ${SEEDS} hostile notes`, () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= SEEDS && failures.length < 5; seed += 1) {
      const random = mulberry32(seed * 7919);
      const body = noteOnDisk(seed, random);
      const parsed = parseMarkdownBody(body);
      const doc = edited(parsed.doc, random);
      let saved: string;
      try {
        saved = serializeMarkdownBody({ originalBody: body, parsed, doc });
      } catch (error) {
        failures.push(`seed ${seed}: save threw ${String(error)}`);
        continue;
      }
      for (const lost of untouchedBytesLost({ parsed, doc, saved })) {
        failures.push(`seed ${seed}: ${lost}`);
      }
      const reread = parseMarkdownBody(saved).doc.content.map(withoutReadIds);
      if (JSON.stringify(reread) !== JSON.stringify(doc.content.map(withoutReadIds))) {
        {
          const a = doc.content.map((n) => n.type).join(',');
          const b = parseMarkdownBody(saved)
            .doc.content.map((n) => n.type)
            .join(',');
          const i = reread.findIndex(
            (n, k) => JSON.stringify(n) !== JSON.stringify(withoutReadIds(doc.content[k]!)),
          );
          failures.push(
            `seed ${seed}: reads back as another note: shown [${a}] read [${b}] first diff at ${i}: shown ${JSON.stringify(withoutReadIds(doc.content[i]!)).slice(0, 300)} read ${JSON.stringify(reread[i]).slice(0, 300)}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('the byte clause itself, against a save written by hand', () => {
  // The middle paragraph moved below the second list, which then stands after
  // the first with the same bullet, and is the one list the save may re-mark.
  const BODY = '- Water.\n\nBetween.\n\n- See www\\.x.com\n';
  const parsed = parseMarkdownBody(BODY);
  const [first, middle, second] = parsed.doc.content;
  const doc: EditorDocument = { type: 'doc', content: [first!, second!, middle!] };

  it('passes the list after re-marked in its own bytes, its escape kept', () => {
    const saved = '- Water.\n\n* See www\\.x.com\n\nBetween.\n';
    expect(untouchedBytesLost({ parsed, doc, saved })).toEqual([]);
  });

  it('goes red when the re-marked list is written afresh, which drops its escape', () => {
    const saved = '- Water.\n\n* See www.x.com\n\nBetween.\n';
    expect(untouchedBytesLost({ parsed, doc, saved })).toHaveLength(1);
  });

  it('goes red when trailing spaces are appended to an untouched paragraph', () => {
    const saved = '- Water.\n\n* See www\\.x.com\n\nBetween.  \n';
    expect(untouchedBytesLost({ parsed, doc, saved })).toHaveLength(1);
  });
});

describe('a move that puts two lists side by side, saved', () => {
  const BODY = '- Water the ferns.\n\nBetween the lists.\n\n- Repot the moss.\n\n^lst002\n';

  /** The note with its middle paragraph moved below the second list, as ⇧⌘↓ does. */
  function savedWithMiddleMovedDown(): { saved: string; shown: EditorDocument } {
    const parsed = parseMarkdownBody(BODY);
    const [first, middle, second] = parsed.doc.content;
    const shown: EditorDocument = { type: 'doc', content: [first!, second!, middle!] };
    return { saved: serializeMarkdownBody({ originalBody: BODY, parsed, doc: shown }), shown };
  }

  it('starts from two lists and a paragraph (the premise)', () => {
    expect(parseMarkdownBody(BODY).doc.content.map((node) => node.type)).toEqual([
      'bulletList',
      'paragraph',
      'bulletList',
    ]);
  });

  it('reads back as the two lists the person sees, not one', () => {
    const { saved } = savedWithMiddleMovedDown();
    expect(parseMarkdownBody(saved).doc.content.map((node) => node.type)).toEqual([
      'bulletList',
      'bulletList',
      'paragraph',
    ]);
  });

  it("keeps the second list's ^id on the second list's item, not on the first's", () => {
    const { saved } = savedWithMiddleMovedDown();
    const reread = parseMarkdownBody(saved).doc.content;
    const anchored = reread.filter((node) => node.attrs?.['anchor'] === 'lst002');
    expect(anchored).toHaveLength(1);
    expect(JSON.stringify(anchored[0])).not.toContain('Water the ferns.');
  });
});
