/**
 * POST /v1/captures (#103, ADR-0049), through the real YAML reader, the real
 * markdown parser and the index's tables: a Slack message sent under
 * capture/v1 lands once in the Inbox as a note or a task, its author linked
 * to their Person note by address, and hostile text in it reads as words.
 * All names are made up.
 */
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Nodes, Root } from 'mdast';
import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf, codeOf, type IndexPort } from '@dfai/application';
import { atlasQueryIndex } from '@dfai/application/testing/sqlite';
import {
  noteTags,
  readCapture,
  relationsOf,
  splitFrontmatter,
  splitWikiLinksAndEmbeds,
} from '@dfai/domain';
import {
  hostileText,
  seededRandom,
  SLACK_PERMALINK,
  SLACK_REPLY_TS,
  slackCapture,
  slackSource,
} from '@dfai/domain/testing';
import { parseMarkdownBody, renderBlock } from './markdown-blocks.ts';
import { remarkMarkdown } from './markdown-port.ts';

type ApiFixture = ReturnType<typeof apiFixture>;

const PATH =
  'Inbox/Captures/Can you send the Larkspur renewal by Friday cc @Tobias Fenn (slack 2db9a3ee).md';
const MARA = [
  '---',
  'type: person',
  'email: Mara.Quill@example.com',
  '---',
  '',
  'Payroll lead.',
  '',
].join('\n');

function vault(
  files: Record<string, string> = {},
  { query }: { query?: (base: IndexPort['query']) => IndexPort['query'] } = {},
) {
  // The index is read once, as the vault was: it lags what the route writes, as the real one does.
  const indexed = atlasQueryIndex({ files, markdown: remarkMarkdown });
  return apiFixture({
    files,
    markdown: remarkMarkdown,
    index: { query: query === undefined ? indexed : query(indexed) },
  });
}

/** The vault as it is now, its index read afresh: what the app sees once it has caught up. */
const reindexed = (api: ApiFixture, moved: Record<string, string> = {}) =>
  vault({
    ...Object.fromEntries([...api.files].map(([path, note]) => [moved[path] ?? path, note.text])),
  });

const send = (api: ApiFixture, body: unknown) =>
  api.send({ method: 'POST', path: '/v1/captures', body });

const messageOf = (response: { body: unknown }) =>
  String((response.body as { error?: { message?: string } }).error?.message);

const frontmatterOf = (text: string) =>
  remarkMarkdown.frontmatterProperties(splitFrontmatter(text).frontmatter);

describe('POST /v1/captures: a Slack message saved as a task', () => {
  it('writes one Inbox task with the text, author, channel and a working permalink', async () => {
    const api = vault();
    const response = await send(api, { ...slackCapture(), timeZone: 'America/Los_Angeles' });

    expect(response.status).toBe(201);
    expect(bodyOf(response)).toEqual({ capture: { path: PATH, outcome: 'written' } });
    const text = api.files.get(PATH)?.text ?? '';
    expect(frontmatterOf(text)).toEqual({
      type: 'task',
      status: 'inbox',
      atlas_import: 'capture/v1',
      provider: 'slack',
      external_id: 'C0LARK5PUR/1793136000.000100',
      source: SLACK_PERMALINK,
      author: 'Mara Quill',
      author_email: 'mara.quill@example.com',
      channel: '#larkspur-payroll',
      sent_at: '2026-10-27T21:20:00.000Z',
    });
    expect(text).toContain('> Can you send the **Larkspur** renewal by Friday? cc @Tobias Fenn');
    expect(text).toContain(`[Open in Slack](${SLACK_PERMALINK})`);
    expect(text).toContain('> **Tobias Fenn** · 2026-10-27 14:25');
  });

  it('is listed in the Inbox as a task waiting to be clarified', async () => {
    const api = vault();
    await send(api, slackCapture());
    const inbox = await reindexed(api).send({ method: 'GET', path: '/v1/inbox' });
    expect(bodyOf(inbox)['items']).toEqual([
      expect.objectContaining({ path: PATH, arrivedIn: 'Captures', type: 'task' }),
    ]);
  });

  it('keeps each reply attributed and citable by its block id', async () => {
    const api = vault();
    await send(api, slackCapture());
    const text = api.files.get(PATH)?.text ?? '';
    const quotes = remarkMarkdown.noteBlocks(text).quotes;
    expect(quotes).toHaveLength(2);
    expect(text).toMatch(/> \*\*Tobias Fenn\*\* · [^\n]+\n>\n> On it\.\n\n\^r1793136300-000200\n/);
  });

  it('links its author to their Person note when the address matches, case aside', async () => {
    const api = vault({ 'People/Mara Quill.md': MARA });
    await send(api, slackCapture());
    const text = api.files.get(PATH)?.text ?? '';
    expect(frontmatterOf(text)['author']).toBe('[[Mara Quill]]');
    expect(text).toContain('> **[[Mara Quill]]** ·');
  });

  it('says the write in Activity by its route and note, never by what the message said', async () => {
    const api = vault();
    await send(api, slackCapture());
    expect(api.activity.reports).toEqual([
      expect.objectContaining({
        kind: 'api',
        level: 'info',
        message: expect.stringContaining('POST v1/captures'),
      }),
    ]);
    expect(JSON.stringify(api.activity.reports)).not.toContain('renewal by Friday');
  });

  it('writes into the Inbox as the vault spells it', async () => {
    const api = vault({ 'inbox/Older.md': '# Older\n' });
    const response = await send(api, slackCapture());
    expect(bodyOf(response)).toEqual({
      capture: {
        path: `inbox/Captures/${PATH.split('/').at(-1)}`,
        outcome: 'written',
      },
    });
  });
});

describe('POST /v1/captures: the same message twice', () => {
  it('is written once, though the index has not read the first yet', async () => {
    const api = vault();
    expect((await send(api, slackCapture())).status).toBe(201);
    const second = await send(api, slackCapture({ kind: 'note' }));
    expect(second.status).toBe(200);
    expect(bodyOf(second)).toEqual({ capture: { path: PATH, outcome: 'in-vault' } });
    expect(api.writes).toHaveLength(1);
  });

  it('is written once when sent again under another title before the index has read the first', async () => {
    const api = vault();
    expect((await send(api, slackCapture())).status).toBe(201);
    const retitled = await send(api, slackCapture({ title: 'Renewal, as pasted' }));
    expect(bodyOf(retitled)).toEqual({ capture: { path: PATH, outcome: 'in-vault' } });
    expect(api.writes).toHaveLength(1);
  });

  it('is recognised after it was filed under a project, by its channel and ts, not its link', async () => {
    const first = vault();
    await send(first, slackCapture());
    const filed = 'Projects/Larkspur/Send the renewal.md';
    const api = reindexed(first, { [PATH]: filed });
    const grid = SLACK_PERMALINK.replace('larkspur.slack.com', 'larkspur.enterprise.slack.com');
    const response = await send(
      api,
      slackCapture({ source: slackSource({ url: `${grid}?cid=C0LARK5PUR` }) }),
    );
    expect(bodyOf(response)).toEqual({
      capture: { path: filed, outcome: 'in-vault' },
    });
    expect(api.writes).toEqual([]);
    expect(api.activity.reports).toEqual([]);
  });

  it('writes another message of the same title beside the first, never over it', async () => {
    const api = vault();
    await send(api, slackCapture());
    const ts = '1793136000.000999';
    const url = SLACK_PERMALINK.replace('p1793136000000100', 'p1793136000000999');
    const response = await send(
      api,
      slackCapture({ source: slackSource({ ts, url }), thread: [] }),
    );
    expect(response.status).toBe(201);
    expect(
      String(bodyOf(response)['capture'] && (bodyOf(response)['capture'] as { path: string }).path),
    ).toMatch(/\(slack [0-9a-f]{8}\)\.md$/);
    expect(api.files.size).toBe(2);
  });
});

describe('POST /v1/captures: a capture the contract refuses', () => {
  it.each([
    ['a misspelt field', { attachment: [] }, '"attachment" is not one of its fields'],
    ['no permalink', { source: slackSource({ url: undefined }) }, 'source.url: missing'],
    [
      'a permalink to another message',
      { source: slackSource({ url: SLACK_PERMALINK.replace('0100', '0101') }) },
      'is not a link to this message',
    ],
    [
      'a reply twice',
      {
        thread: [
          { ts: SLACK_REPLY_TS, author: { name: 'T' }, text: 'a' },
          { ts: SLACK_REPLY_TS, author: { name: 'T' }, text: 'b' },
        ],
      },
      'twice',
    ],
    [
      'a zone that is not one',
      { timeZone: 'Mars/Olympus' },
      'timeZone: "Mars/Olympus" is not a time zone',
    ],
    ['a zone that is not text', { timeZone: 7 }, 'timeZone'],
  ])('refuses %s with its reasons, writing nothing', async (_, fields, reason) => {
    const api = vault();
    const response = await send(api, { ...slackCapture(), ...fields });
    expect(response.status).toBe(400);
    expect(codeOf(response)).toBe('invalid');
    expect(messageOf(response)).toContain(reason);
    expect(api.writes).toEqual([]);
    expect(api.folders.size).toBe(0);
  });

  it('names every reason at once', async () => {
    const response = await send(vault(), { contract: 'capture/v1', kind: 'memo', source: {} });
    const message = messageOf(response);
    for (const reason of [
      'kind: "memo"',
      'source.provider',
      'source.ts: missing',
      'source.url: missing',
    ]) {
      expect(message).toContain(reason);
    }
  });

  it('refuses a body that is not an object', async () => {
    expect(codeOf(await send(vault(), ['not', 'a', 'capture']))).toBe('invalid');
  });

  it('answers exists when another note holds its path', async () => {
    const other = '---\ntype: task\n---\n\nElse.\n';
    const name = 'Can you send the Larkspur renewal by Friday cc @Tobias Fenn';
    const api = vault({ [PATH]: other });
    await send(
      api,
      slackCapture({
        source: slackSource({
          ts: '1793136000.000555',
          url: SLACK_PERMALINK.replace('0100', '0555'),
        }),
        thread: [],
      }),
    );
    const collision = [...api.files.keys()].find((path) => path !== PATH) ?? '';
    expect(collision).toContain(name);
    const crowded = vault({ [PATH]: other, [collision]: other });
    const response = await send(
      crowded,
      slackCapture({
        source: slackSource({
          ts: '1793136000.000555',
          url: SLACK_PERMALINK.replace('0100', '0555'),
        }),
        thread: [],
      }),
    );
    expect(codeOf(response)).toBe('exists');
  });
});

describe('POST /v1/captures: the vault is switched mid-request', () => {
  const OTHER = { absolutePath: '/Users/j/Other', name: 'Other' };

  it('writes into neither vault when the switch comes before the write', async () => {
    let api: ApiFixture | null = null;
    api = vault(
      {},
      {
        query: (base) => async (sql, parameters) => {
          if (api !== null) api.open = OTHER;
          return base(sql, parameters);
        },
      },
    );
    expect(codeOf(await send(api, slackCapture()))).toBe('no_vault');
    expect(api.writes).toEqual([]);
  });
});

/*
 * Hostile text through the real parser: whatever a message, a name or a
 * title holds, the note reads back as the contract's frontmatter and a body
 * of quotes, with no tag, wiki link, embed, image, HTML, table, heading or
 * info-string fence of the sender's making.
 */

/** Every node of a tree, depth first. */
function* nodesOf(node: Nodes): Generator<Nodes> {
  yield node;
  if ('children' in node) for (const child of node.children) yield* nodesOf(child as Nodes);
}

/** The body as the editor writes it back once each of its blocks is edited. */
const editedBack = (body: string) =>
  parseMarkdownBody(body)
    .doc.content.map((node) => renderBlock(node))
    .join('\n\n');

const parse = (body: string) => unified().use(remarkParse).use(remarkGfm).parse(body) as Root;

describe('POST /v1/captures: hostile text, over 200 seeded messages, through the real parser', () => {
  it.each(Array.from({ length: 200 }, (_, at) => at + 1))(
    'seed %i reads back as words',
    async (seed) => {
      const random = seededRandom(seed);
      const name = hostileText(random, 6);
      const api = vault();
      const sent = slackCapture({
        title: random() < 0.5 ? hostileText(random, 8) : null,
        text: hostileText(random, 30),
        source: slackSource({ author: { name, email: 'mara.quill@example.com' } }),
        thread: [
          {
            ts: SLACK_REPLY_TS,
            author: { name: hostileText(random, 4) },
            text: hostileText(random, 20),
          },
        ],
        attachments: [{ name: hostileText(random, 4), url: 'https://files.slack.com/a.pdf' }],
      });
      const response = await send(api, sent);
      // Names are hostile, not prefixed to be safe: one that cleans away to nothing is refused.
      if (response.status === 400) {
        expect(messageOf(response)).toMatch(
          /^The capture was refused: [^;]*name: is blank(?:; [^;]*name: is blank)*$/,
        );
        return;
      }
      expect(response.status).toBe(201);
      const path = (bodyOf(response)['capture'] as { path: string }).path;
      const text = api.files.get(path)?.text ?? '';
      const { frontmatter, body } = splitFrontmatter(text);

      const properties = remarkMarkdown.frontmatterProperties(frontmatter);
      expect(Object.keys(properties)).toEqual([
        'type',
        'status',
        'atlas_import',
        'provider',
        'external_id',
        'source',
        'author',
        'author_email',
        'channel',
        'sent_at',
      ]);
      expect(remarkMarkdown.frontmatterProblem(frontmatter)).toBeNull();
      // The name as the contract reads it — cleaned, one line, brackets made parentheses — comes back.
      expect(properties['author']).toBe(
        readCapture(sent).message.author.name.replace(/\[/g, '(').replace(/\]/g, ')'),
      );

      // No frontmatter value a sender wrote is a relation (review of PR #615).
      expect(relationsOf(properties, () => null)).toEqual([]);

      // No tag, wiki link or embed — as written, and once every block is edited and written back.
      for (const markdown of [body, editedBack(body)]) {
        const ranges = remarkMarkdown.textRanges(markdown);
        expect(noteTags({ tagsProperty: undefined, body: markdown, ranges })).toEqual([]);
        expect(splitWikiLinksAndEmbeds(markdown).filter((piece) => piece.kind !== 'text')).toEqual(
          [],
        );
      }

      const tree = parse(body);
      const kinds = new Set([...nodesOf(tree)].map((node) => node.type));
      for (const kind of [
        'html',
        'image',
        'imageReference',
        'table',
        'definition',
        'footnoteDefinition',
        'footnoteReference',
        'thematicBreak',
      ]) {
        expect(kinds.has(kind as Nodes['type']), kind).toBe(false);
      }
      for (const node of nodesOf(tree)) {
        if (node.type === 'heading') expect(node.depth).toBe(2);
        if (node.type === 'code') expect(node.lang ?? null).toBeNull();
        if (node.type === 'link') expect(node.url).toMatch(/^(https?:\/\/|mailto:)/);
      }
      const headings = tree.children.filter((node) => node.type === 'heading');
      expect(
        headings.map((node) => body.slice(node.position?.start.offset, node.position?.end.offset)),
      ).toEqual(['## Thread', '## Attachments']);
      expect(tree.children.filter((node) => node.type === 'blockquote')).toHaveLength(2);
    },
  );
});
