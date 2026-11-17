import { describe, expect, it } from 'vitest';
import type { EditorDocument, EditorNode, ParsedBody } from '@dfai/domain';
import { parseMarkdownBody, RAW_BLOCK, serializeMarkdownBody } from './markdown-blocks.ts';
import { documentOf, generatedDocument, seedRuns } from './writer-fuzz.test-support.ts';
import {
  shapesNotIn,
  shapesOf,
  unlistedFamilies,
  WRITER_FAMILIES,
} from './writer-shapes.test-support.ts';

/**
 * The writer's promise (A21-03): an edited block reads back as the editor had
 * it. Editor documents — every block kind the editor writes, text full of
 * markdown's punctuation, every mark — go through the writer and the reader,
 * and must come back as the same document, adjacent text merged.
 *
 * The one other outcome allowed is a block read back as its own source, shown
 * read-only (ADR-0004): markdown that cannot be written faithfully is kept as
 * written rather than turned silently into something else.
 *
 * Seeds: 100 by default, in `it`s of 25, beside the listed families that
 * hold every shape the property turns on; that keeps each pull request's run
 * to seconds (#888). The 3000 the property once ran every time are for a
 * nightly run, `WRITER_SEEDS=3000` (#896): rare combinations still turn up
 * there, and each one found is listed as a family.
 */

interface Saved {
  readonly markdown: string;
  readonly parsed: ParsedBody;
}

/**
 * A new note holding `doc`, saved and read back: once per document, since
 * both properties start from it.
 */
const savedOnce = new WeakMap<EditorDocument, Saved>();
function saveAndReload(doc: EditorDocument): Saved {
  const known = savedOnce.get(doc);
  if (known !== undefined) return known;
  const markdown = serializeMarkdownBody({ originalBody: '', parsed: parseMarkdownBody(''), doc });
  const saved = { markdown, parsed: parseMarkdownBody(markdown) };
  savedOnce.set(doc, saved);
  return saved;
}

/** The same note, with every text block in it given one more word, saved over itself. */
function editedEverywhere(doc: EditorDocument): EditorDocument {
  const edit = (node: EditorNode): EditorNode => {
    if (node.type === 'paragraph' || node.type === 'heading')
      return { ...node, content: [{ type: 'text', text: 'Q ' }, ...(node.content ?? [])] };
    return node.content === undefined ? node : { ...node, content: node.content.map(edit) };
  };
  return { type: 'doc', content: doc.content.map(edit) };
}

type Outcome = 'same' | 'raw' | 'different';

function outcomeOf(doc: EditorDocument, reread: readonly EditorNode[]): Outcome {
  if (documentOf(reread) === documentOf(doc.content)) return 'same';
  // Block by block: each reads back as it was, or as its own source.
  const blocks = doc.content.filter((node) => node.type !== 'paragraph' || node.content?.length);
  if (blocks.length !== reread.length) return 'different';
  const each = blocks.map((node, at) =>
    documentOf([reread[at]!]) === documentOf([node])
      ? 'same'
      : reread[at]!.type === RAW_BLOCK
        ? 'raw'
        : 'different',
  );
  return each.includes('different') ? 'different' : 'raw';
}

interface Case {
  readonly name: string;
  readonly doc: EditorDocument;
}

/** The cases whose documents do not read back as written, with their markdown, for the report. */
function misread(cases: readonly Case[], check: (doc: EditorDocument) => [Outcome, string]) {
  const different: string[] = [];
  const raw: string[] = [];
  for (const { name, doc } of cases) {
    let outcome: Outcome;
    let markdown: string;
    try {
      [outcome, markdown] = check(doc);
    } catch (error) {
      [outcome, markdown] = ['different', `threw ${String(error)}`];
    }
    if (outcome === 'raw') raw.push(name);
    if (outcome === 'different') different.push(`${name}: ${JSON.stringify(markdown)}`);
  }
  return { different, raw };
}

/**
 * Kept as source is the last resort, not the answer: no listed document is,
 * each is built to be written faithfully, and a seed only rarely — 6 of the
 * first 3000 (347, 787, 892, 1927, 2584, 2877), never two in a run of 25.
 */
function expectReadBack(
  cases: readonly Case[],
  check: (doc: EditorDocument) => [Outcome, string],
  { keptAsSource = 0 }: { keptAsSource?: number } = {},
) {
  const { different, raw } = misread(cases, check);
  expect(different.slice(0, 8), `${different.length} of ${cases.length} read differently`).toEqual(
    [],
  );
  expect(raw.length, `kept as source: ${raw.join(', ')}`).toBeLessThanOrEqual(keptAsSource);
}

function writtenAfresh(doc: EditorDocument): [Outcome, string] {
  const { markdown, parsed } = saveAndReload(doc);
  return [outcomeOf(doc, parsed.doc.content), markdown];
}

function editedAgain(first: EditorDocument): [Outcome, string] {
  const { markdown: original, parsed } = saveAndReload(first);
  if (parsed.doc.content.some((node) => node.type === RAW_BLOCK)) return ['same', original];
  const doc = editedEverywhere(parsed.doc);
  const markdown = serializeMarkdownBody({ originalBody: original, parsed, doc });
  const reread = [...parseMarkdownBody(markdown).doc.content];
  return [outcomeOf(doc, reread), `${original}\n=>\n${markdown}`];
}

const casesOf = (family: string, documents: readonly EditorDocument[]): Case[] =>
  documents.map((doc, at) => ({ name: `${family} ${at}`, doc }));

/**
 * The listed documents, a family at a time, each holding every shape of its
 * family (`WRITER_FAMILIES`): every piece of the generator's text at each end
 * of every kind of text block and under every mark, every kind of block,
 * nesting, atom, link, embed and id, everything beside everything, and
 * addresses running on. 3000 seeds drew them too, and took up to 105 s on CI
 * to do it (#888). A few seeds still run, for what nobody thought to list.
 */
const SEED_RUNS = seedRuns({
  name: 'WRITER_SEEDS',
  set: process.env['WRITER_SEEDS'],
  fallback: 100,
  size: 25,
});
const seededFrom = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, at) => generatedDocument(first + at));

/** How many seeds the guard draws: the generator alone, with no writer, so it is quick. */
const GUARD_SEEDS = 400;

/** Every shape `docs` hold between them. */
const shapesIn = (docs: readonly EditorDocument[]) =>
  new Set(docs.flatMap((doc) => [...shapesOf(doc)]));

describe('a limit of markdown the writer keeps as source (ADR-0004)', () => {
  it('keeps a tag straight before a bold run that starts with punctuation as source', () => {
    // `**` cannot open after a letter before punctuation, and `#&#x78;` is no
    // longer the tag `#x`: no markdown reads back as this. A writer that finds
    // one will fail here, and this test can then go.
    const doc: EditorDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '#x' },
            { type: 'text', text: '_', marks: [{ type: 'bold' }] },
          ],
        },
      ],
    };
    const { markdown, parsed } = saveAndReload(doc);
    expect(markdown).toBe('#&#x78;**\\_**\n');
    expect(parsed.doc.content.map((node) => [node.type, node.attrs?.['markdown']])).toEqual([
      [RAW_BLOCK, '#&#x78;**\\_**'],
    ]);
  });
});

describe('an edited block reads back as the editor had it', () => {
  it('lists the documents of every family of shapes', () => {
    expect(unlistedFamilies()).toEqual([]);
  });

  // The lists the listed documents are built from are typed out, where the
  // generator writes its kinds inline: a kind or a shape it gains must be listed too.
  it(`lists every shape ${GUARD_SEEDS} seeds of the generator draw`, () => {
    const listed = shapesIn(WRITER_FAMILIES.flatMap((family) => family.documents));
    const seeded = shapesIn(seededFrom(1, GUARD_SEEDS));
    expect([...seeded].filter((shape) => !listed.has(shape)).sort()).toEqual([]);
  });

  describe.each([
    ['written afresh', writtenAfresh],
    ['saved, reopened and edited again', editedAgain],
  ] as const)('%s', (_way, check) => {
    it.each(WRITER_FAMILIES.map((family) => [family.name, family] as const))(
      'holds for %s, which its listed documents all hold',
      (_name, family) => {
        expect(shapesNotIn(family.documents, family.shapes)).toEqual([]);
        expectReadBack(casesOf(family.name, family.documents), check);
      },
    );

    it.each(SEED_RUNS)('holds for seeded documents %i to %i', (first, last) => {
      const seeded = seededFrom(first, last).map((doc, at) => ({
        name: `seed ${first + at}`,
        doc,
      }));
      expectReadBack(seeded, check, { keptAsSource: 1 });
    });
  });
});
