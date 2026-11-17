import { describe, expect, it } from 'vitest';
import type { EditorDocument, EditorNode, ParsedBody } from '@dfai/domain';
import { parseMarkdownBody, RAW_BLOCK, serializeMarkdownBody } from './markdown-blocks.ts';
import { documentOf, generatedDocument } from './writer-fuzz.test-support.ts';
import { shapesNotIn, WRITER_FAMILIES } from './writer-shapes.test-support.ts';

/**
 * The writer's promise (A21-03): an edited block reads back as the editor had
 * it. Editor documents — every block kind the editor writes, text full of
 * markdown's punctuation, every mark — go through the writer and the reader,
 * and must come back as the same document, adjacent text merged.
 *
 * The one other outcome allowed is a block read back as its own source, shown
 * read-only (ADR-0004): markdown that cannot be written faithfully is kept as
 * written rather than turned silently into something else.
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
 * each is built to be written faithfully, and a seed only rarely (6 of the
 * first 3000, none of these).
 */
function expectReadBack(cases: readonly Case[], check: (doc: EditorDocument) => [Outcome, string]) {
  const { different, raw } = misread(cases, check);
  expect(different.slice(0, 8), `${different.length} of ${cases.length} read differently`).toEqual(
    [],
  );
  expect(raw, 'kept as source').toEqual([]);
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
const SEEDS = 12;
const SEEDED = Array.from({ length: SEEDS }, (_, at) => generatedDocument(at + 1));

describe('an edited block reads back as the editor had it', () => {
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

    it(`holds for ${SEEDS} seeded documents`, () => {
      expectReadBack(casesOf('seed', SEEDED), check);
    });
  });
});
