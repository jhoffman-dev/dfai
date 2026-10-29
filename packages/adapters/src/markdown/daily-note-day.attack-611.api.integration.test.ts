/**
 * Attack on PR #611 (#110), through the real markdown reader and writer:
 * `POST /v1/daily` in a vault whose Task type can run the day's blocks and
 * in one whose cannot, two asks at once, a half-written type file, a Daily
 * template, and the made note's fences through an edit and a save
 * (ADR-0003: untouched bytes stay as they were).
 */
import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf } from '@dfai/application';
import {
  dailyDaySections,
  dailyNoteContents,
  queryBlockNode,
  splitFrontmatter,
  TASK_TYPE_FILE,
  type EditorDocument,
  type EditorNode,
} from '@dfai/domain';
import { parseMarkdownBody, serializeMarkdownBody } from './markdown-blocks.ts';
import { remarkMarkdown } from './markdown-port.ts';

const GTD_TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '  due: date',
  '  defer: date',
  '---',
  '',
].join('\n');

/** The api fixture's clock day. */
const TODAY = '2026-09-22';

const OLD_CONTENTS = '---\ntype: daily\n---\n\n## What happened\n\n## What is next\n';

const vault = (files: Record<string, string>) => apiFixture({ files, markdown: remarkMarkdown });

const madeNote = (api: ReturnType<typeof vault>) =>
  [...api.writes].reverse().find((write) => write.path.endsWith(`${TODAY}.md`))?.contents ?? '';

const fences = (text: string) => text.match(/```atlas-query\n[\s\S]*?\n```/g) ?? [];

describe('#611 attack: POST /v1/daily, through the real markdown port', () => {
  it('answers 201 with a note holding both day blocks in a vault whose Task type fits', async () => {
    const api = vault({ '.atlas/types/task.md': GTD_TASK_TYPE });
    const response = await api.send({ method: 'POST', path: '/v1/daily' });
    expect(response.status).toBe(201);
    expect(fences(madeNote(api))).toHaveLength(2);
    expect(String((bodyOf(response)['note'] as { body: string }).body)).toContain(
      `due <= ${TODAY}`,
    );
  });

  it('writes exactly the old contents when the Task type keeps due as text', async () => {
    const api = vault({ '.atlas/types/task.md': GTD_TASK_TYPE.replace('due: date', 'due: text') });
    await api.send({ method: 'POST', path: '/v1/daily' });
    expect(madeNote(api)).toBe(OLD_CONTENTS);
  });

  it('writes exactly the old contents when task.md is cut off mid-file', async () => {
    const half = GTD_TASK_TYPE.slice(0, GTD_TASK_TYPE.indexOf('  due: date'));
    const api = vault({ '.atlas/types/task.md': half });
    const response = await api.send({ method: 'POST', path: '/v1/daily' });
    expect(response.status).toBe(201);
    expect(madeNote(api)).toBe(OLD_CONTENTS);
  });

  it('starts from the Daily template, not the blocks, when the vault has one', async () => {
    const template = '---\ntype: daily\n---\n\n## Today\n';
    const api = vault({
      '.atlas/types/task.md': GTD_TASK_TYPE,
      '.atlas/templates/Daily.md': template,
    });
    await api.send({ method: 'POST', path: '/v1/daily' });
    expect(madeNote(api)).toBe(template);
  });

  it('makes one note when two asks arrive at once: one 201, one 200', async () => {
    const api = vault({ '.atlas/types/task.md': GTD_TASK_TYPE });
    const answers = await Promise.all([
      api.send({ method: 'POST', path: '/v1/daily' }),
      api.send({ method: 'POST', path: '/v1/daily' }),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 201]);
    expect(api.writes.filter((write) => write.path.endsWith(`${TODAY}.md`))).toHaveLength(1);
  });
});

describe("#611 attack: the day's fences through the editor's save (ADR-0003)", () => {
  const made = dailyNoteContents({ day: '2026-12-31', types: [TASK_TYPE_FILE.type] });
  const { body } = splitFrontmatter(made);

  function saveAfter(edit: (content: EditorNode[]) => EditorNode[]): string {
    const parsed = parseMarkdownBody(body);
    const doc: EditorDocument = { type: 'doc', content: edit([...parsed.doc.content]) };
    return serializeMarkdownBody({ originalBody: body, parsed, doc });
  }

  it('reads both fences as query blocks', () => {
    const types = parseMarkdownBody(body).doc.content.map((node) => node.type);
    expect(types.filter((type) => type === queryBlockNode('').type)).toHaveLength(2);
  });

  it('saves the note untouched byte for byte', () => {
    expect(saveAfter((content) => content)).toBe(body);
  });

  it('keeps both fences byte for byte when a line is written under What happened', () => {
    const saved = saveAfter((content) => {
      const at = content.findIndex(
        (node) => node.type === 'heading' && JSON.stringify(node).includes('What happened'),
      );
      const line: EditorNode = {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Tobias Fenn moved the seed swap to Saturday.' }],
      };
      return [...content.slice(0, at + 1), line, ...content.slice(at + 1)];
    });
    expect(fences(saved)).toEqual(fences(body));
    expect(saved).toContain('Tobias Fenn moved the seed swap');
  });

  it('writes a query block made afresh with the same text as the same fence', () => {
    const texts = dailyDaySections('2026-12-31').map((section) => section.block);
    let seen = 0;
    const saved = saveAfter((content) =>
      content.map((node) =>
        node.type === queryBlockNode('').type ? queryBlockNode(texts[seen++] ?? '') : node,
      ),
    );
    expect(seen).toBe(2);
    expect(fences(saved).join('\n\n')).toBe(fences(body).join('\n\n'));
  });
});
