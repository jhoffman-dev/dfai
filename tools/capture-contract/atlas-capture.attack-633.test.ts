/**
 * Attack on PR #633 (#106): `atlas_capture`'s schema against capture/v1 as
 * `readCapture` reads it (ADR-0049). The tool may let through what only a
 * pattern or a length refuses — that is left to the contract — but it must
 * refuse nothing the contract takes, and send exactly what the model gave,
 * nulls aside. Seeded, so a failure names the case that broke. All names
 * are made up. Here, not in apps/mcp, because the MCP server may not import
 * the domain (eslint.config.js): only a test outside it can hold both.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The contract itself, as the oracle: the route reads every capture through it (captures.ts).
import { readCapture } from '@dfai/domain';
import { connectInMemoryMcp } from '../../apps/mcp/src/testing/in-memory-mcp.ts';

type Json = Record<string, unknown>;

const CHANNEL = 'C0LARK5PUR';
const TS = '1793136000.000100';
const PERMALINK = `https://larkspur.slack.com/archives/${CHANNEL}/p1793136000000100`;
const REPLY_TS = '1793136300.000200';
const REPLY_LINK = `https://larkspur.slack.com/archives/${CHANNEL}/p1793136300000200`;

/** A message with every field the tool takes, each one valid. */
function fullMessage(): Json {
  return {
    kind: 'note',
    title: 'Larkspur renewal',
    source: {
      channel: { id: CHANNEL, name: 'larkspur-payroll' },
      ts: TS,
      url: PERMALINK,
      author: { id: 'U0MARAQ111', name: 'Mara Quill', email: 'mara.quill@example.com' },
    },
    text: 'Send the *Larkspur* renewal by Friday <@U0TOBIAS22>',
    thread: [
      {
        ts: REPLY_TS,
        author: { id: 'U0TOBIAS22', name: 'Tobias Fenn', email: 'tobias.fenn@example.com' },
        text: 'On it.',
        url: REPLY_LINK,
      },
    ],
    attachments: [{ name: 'renewal.pdf', url: 'https://files.slack.com/renewal.pdf' }],
    users: { U0TOBIAS22: 'Tobias Fenn' },
    timeZone: 'America/Los_Angeles',
  };
}

/** Each field's path and the contract's cap on its length, where it has one. */
const AUTHOR = (at: string) => [
  { path: `${at}.id`, max: 40 },
  { path: `${at}.name`, max: 200 },
  { path: `${at}.email`, max: 254 },
];
const LEAVES: readonly { path: string; max?: number }[] = [
  { path: 'kind' },
  { path: 'title', max: 500 },
  { path: 'source.channel.id', max: 40 },
  { path: 'source.channel.name', max: 80 },
  { path: 'source.ts', max: 17 },
  { path: 'source.url', max: 2_000 },
  ...AUTHOR('source.author'),
  { path: 'text', max: 40_000 },
  { path: 'thread.0.ts', max: 17 },
  ...AUTHOR('thread.0.author'),
  { path: 'thread.0.text', max: 40_000 },
  { path: 'thread.0.url', max: 2_000 },
  { path: 'attachments.0.name', max: 200 },
  { path: 'attachments.0.url', max: 2_000 },
  { path: 'users.U0TOBIAS22', max: 200 },
  { path: 'timeZone' },
];
const OBJECTS = [
  '',
  'source',
  'source.channel',
  'source.author',
  'thread.0',
  'thread.0.author',
  'attachments.0',
  'users',
];
const CONTAINERS = [
  'source',
  'source.channel',
  'source.author',
  'thread',
  'thread.0',
  'attachments',
  'attachments.0',
  'users',
];

/** mulberry32: a small seeded generator, so every run makes the same cases. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const pick = <T>(rng: () => number, from: readonly T[]): T =>
  from[Math.floor(rng() * from.length)] as T;

function parentOf(root: Json, path: string): { holder: Json; key: string } | null {
  const keys = path.split('.');
  const key = keys.pop() as string;
  let holder: unknown = root;
  for (const each of keys) {
    if (typeof holder !== 'object' || holder === null) return null;
    holder = (holder as Json)[each];
  }
  return typeof holder === 'object' && holder !== null ? { holder: holder as Json, key } : null;
}

function at(root: Json, path: string): unknown {
  if (path === '') return root;
  const place = parentOf(root, path);
  return place === null ? undefined : place.holder[place.key];
}

/** Gone, as JSON can say it: a list item is taken out, never left a hole JSON has no form for. */
function remove(holder: Json, key: string): void {
  if (Array.isArray(holder)) holder.splice(Number(key), 1);
  else delete holder[key];
}

const sized = (unit: string, length: number) =>
  unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

/** One change to a leaf: a wrong type, null, gone, or text at, past or around its cap. */
function changeLeaf(rng: () => number, root: Json, leaf: { path: string; max?: number }): string {
  const place = parentOf(root, leaf.path);
  if (place === null) return 'skipped';
  const { holder, key } = place;
  const max = leaf.max ?? 30;
  const changes: Record<string, () => void> = {
    null: () => (holder[key] = null),
    missing: () => remove(holder, key),
    number: () => (holder[key] = pick(rng, [0, -1, 42, Number.NaN])),
    boolean: () => (holder[key] = pick(rng, [true, false])),
    list: () => (holder[key] = []),
    object: () => (holder[key] = {}),
    empty: () => (holder[key] = ''),
    blank: () => (holder[key] = ' \t '),
    atCap: () => (holder[key] = sized('a', max)),
    pastCap: () => (holder[key] = sized('a', max + 1)),
    emojiAtCap: () => (holder[key] = sized('😀', max * 2)),
    nul: () => (holder[key] = `${String(holder[key] ?? '')}\u0000‮😀é`),
    task: () => (holder[key] = 'task'),
  };
  const name = pick(rng, Object.keys(changes));
  changes[name]?.();
  return `${leaf.path}:${name}`;
}

/** One change to an object or a list: a key it does not have, or it gone, null, empty or long. */
function changeContainer(rng: () => number, root: Json): string {
  const path = pick(rng, [...OBJECTS, ...CONTAINERS]);
  const value = at(root, path);
  const place = path === '' ? null : parentOf(root, path);
  const changes: Record<string, () => void> = {
    extraKey: () => {
      if (typeof value === 'object' && value !== null && !Array.isArray(value))
        (value as Json)[
          pick(rng, ['replies', 'thread_ts', 'files', 'provider', 'contract', 'Text', 'U0EXTRA999'])
        ] = 'x';
    },
    constructorKey: () => {
      if (typeof value === 'object' && value !== null && !Array.isArray(value))
        (value as Json)['constructor'] = 'x';
    },
    null: () => place && (place.holder[place.key] = null),
    missing: () => place && remove(place.holder, place.key),
    emptied: () => {
      if (Array.isArray(value)) value.length = 0;
      else if (place && typeof value === 'object' && value !== null) place.holder[place.key] = {};
    },
    wrongType: () => place && (place.holder[place.key] = pick(rng, ['x', 7, [1], true])),
    nullItem: () => Array.isArray(value) && value.push(null),
    secondReply: () => {
      if (path === 'thread' && Array.isArray(value))
        value.push({ ts: '1793136400.000300', author: { name: 'Ines Halloway' }, text: 'Same.' });
    },
    parentAsReply: () => {
      if (path === 'thread' && Array.isArray(value))
        value.push({ ts: TS, author: { name: 'Mara Quill' }, text: 'Send it' });
    },
    pastListCap: () => {
      if (path === 'attachments' && Array.isArray(value))
        for (let n = 0; n < 101; n += 1)
          value.push({ name: `f${n}.pdf`, url: 'https://files.slack.com/f.pdf' });
    },
  };
  const name = pick(rng, Object.keys(changes));
  changes[name]?.();
  return `${path || '(top)'}:${name}`;
}

interface Case {
  readonly label: string;
  readonly input: Json;
}

function cases(seed: number, count: number): Case[] {
  const rng = seeded(seed);
  return Array.from({ length: count }, (_, n) => {
    const input = fullMessage();
    if (rng() < 0.5)
      for (const field of ['title', 'thread', 'attachments', 'users', 'timeZone'])
        if (rng() < 0.5) delete input[field];
    const changes = 1 + Math.floor(rng() * 3);
    const labels: string[] = [];
    for (let k = 0; k < changes; k += 1)
      labels.push(
        rng() < 0.7 ? changeLeaf(rng, input, pick(rng, LEAVES)) : changeContainer(rng, input),
      );
    return { label: `seed ${seed} #${n}: ${labels.join(', ')}`, input };
  });
}

/** What the model meant, as capture/v1: the tool's two fields filled in, the route's zone set aside. */
function intended(input: Json): { payload: Json; timeZone: unknown } {
  const { timeZone, source, ...rest } = input;
  const filledSource =
    typeof source === 'object' && source !== null && !Array.isArray(source)
      ? { provider: 'slack', ...(source as Json) }
      : source;
  return { payload: { contract: 'capture/v1', ...rest, source: filledSource }, timeZone };
}

/** The contract's verdict: the capture it reads, or the reasons it refuses. */
function verdict(payload: unknown, timeZone: unknown): { capture?: unknown; reasons?: string[] } {
  const reasons: string[] = [];
  if (timeZone !== undefined && timeZone !== null && typeof timeZone !== 'string')
    reasons.push('timeZone: must be a string');
  try {
    const capture = readCapture(payload);
    return reasons.length === 0 ? { capture } : { reasons };
  } catch (error) {
    const message = (error as Error).message.replace(/^The capture was refused: /, '');
    return { reasons: [...reasons, ...message.split('; ')] };
  }
}

/**
 * The refusals the tool leaves to the contract on purpose (the PR: "patterns
 * and lengths are left to readCapture"): text too long, blank, ill formed,
 * or a list past its cap — each one still reaching the model whole.
 */
const LEFT_TO_THE_CONTRACT =
  /is longer than|is blank|is not well formed|is not a Slack user id|is not an address|is not an https:\/\/ link|is not a Slack permalink|is not a link to this message|missing: the message’s permalink|is empty, and there is no attachment|holds more than|holds \d+\.\d+ twice|names more than/;

function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== null)
      .map(([key, field]) => [key, withoutNulls(field)]),
  );
}

let mcp: Awaited<ReturnType<typeof connectInMemoryMcp>>;
let sent: unknown[] = [];

beforeAll(async () => {
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({ capture: { path: 'Inbox/Captures/x.md', outcome: 'written' } }),
      {
        status: 201,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof globalThis.fetch;
  mcp = await connectInMemoryMcp({ fetch });
});

afterAll(async () => {
  await mcp.close();
});

async function call(input: Json): Promise<{ refused: boolean; text: string; body: unknown }> {
  sent = [];
  const result = await mcp.callTool({ name: 'atlas_capture', arguments: input });
  const [first] = result.content as { text: string }[];
  return { refused: result.isError === true, text: first?.text ?? '', body: sent[0] };
}

const SEEDS = [633, 106, 20261029];
const PER_SEED = 250;

describe('atlas_capture against capture/v1, case by seeded case (attack on PR #633)', () => {
  it('refuses nothing the contract takes', async () => {
    const wrong: string[] = [];
    const seen = { refused: 0, sent: 0, taken: 0 };
    for (const seed of SEEDS)
      for (const { label, input } of cases(seed, PER_SEED)) {
        const { payload, timeZone } = intended(structuredClone(input));
        const contract = verdict(payload, timeZone);
        const tool = await call(input);
        if (tool.refused && contract.capture !== undefined) wrong.push(`${label} → ${tool.text}`);
        seen[tool.refused ? 'refused' : 'sent'] += 1;
        if (contract.capture !== undefined) seen.taken += 1;
      }
    expect(wrong).toEqual([]);
    // Not vacuous: the cases reach both sides, and the contract takes a good share of them.
    expect(Math.min(seen.refused, seen.sent, seen.taken)).toBeGreaterThan(100);
  });

  it('lets through only what a pattern or a length refuses, never a shape the contract refuses', async () => {
    const wrong: string[] = [];
    let leftToContract = 0;
    for (const seed of SEEDS)
      for (const { label, input } of cases(seed, PER_SEED)) {
        const { payload, timeZone } = intended(structuredClone(input));
        const contract = verdict(payload, timeZone);
        const tool = await call(input);
        if (tool.refused || contract.reasons === undefined) continue;
        leftToContract += 1;
        const shaped = contract.reasons.filter((reason) => !LEFT_TO_THE_CONTRACT.test(reason));
        if (shaped.length > 0) wrong.push(`${label} → ${shaped.join('; ')}`);
      }
    expect(wrong).toEqual([]);
    expect(leftToContract).toBeGreaterThan(50);
  });

  it('sends exactly what the model gave, its nulls dropped and nothing else changed', async () => {
    const wrong: string[] = [];
    let compared = 0;
    for (const seed of SEEDS)
      for (const { label, input } of cases(seed, PER_SEED)) {
        const { payload, timeZone } = intended(structuredClone(input));
        const tool = await call(input);
        if (tool.refused) continue;
        compared += 1;
        const expected = withoutNulls(
          timeZone === null || timeZone === undefined ? payload : { ...payload, timeZone },
        );
        try {
          expect(tool.body).toEqual(expected);
        } catch {
          wrong.push(label);
        }
      }
    expect(wrong).toEqual([]);
    expect(compared).toBeGreaterThan(100);
  });
});

interface ListedSchema {
  readonly properties?: Record<string, ListedSchema>;
  readonly anyOf?: readonly ListedSchema[];
  readonly items?: ListedSchema;
}

/** Every field the listed schema offers, by where it sits in a message (`thread.0.author.id`). */
function listedFields(schema: ListedSchema, at: string): string[] {
  const here = at === '' ? '' : `${at}.`;
  const own = Object.entries(schema.properties ?? {}).flatMap(([key, child]) => [
    `${here}${key}`,
    ...listedFields(child, `${here}${key}`),
  ]);
  const inList = schema.items === undefined ? [] : listedFields(schema.items, `${at}.0`);
  const either = (schema.anyOf ?? []).flatMap((each) => listedFields(each, at));
  return [...own, ...inList, ...either];
}

describe('atlas_capture as listed, against capture/v1 (attack on PR #633)', () => {
  it('offers the model no field the contract would refuse as not one of its own', async () => {
    const tool = (await mcp.listTools()).tools.find((each) => each.name === 'atlas_capture');
    const fields = listedFields(tool?.inputSchema as ListedSchema, '');
    expect(fields).toEqual(expect.arrayContaining(['source.channel.id', 'thread.0.author.email']));

    const refused = fields.filter((path) => {
      const input = fullMessage();
      const place = parentOf(input, path);
      if (place === null) return false;
      place.holder[place.key] ??= 'x';
      const { payload, timeZone } = intended(input);
      return (verdict(payload, timeZone).reasons ?? []).some((reason) =>
        reason.includes('is not one of its fields'),
      );
    });
    expect(refused).toEqual([]);
  });
});
