import { describe, expect, it } from 'vitest';
import {
  AFTER_A_MEETING_PROMPT,
  createVaultPath,
  parseObjectType,
  type AutomationRule,
} from '@dfai/domain';
import { automationVault, jsonNote, TASK_TYPES } from '../testing/automation-vault.ts';
import { MEETING_BODY, MEETING_HEADER } from '../testing/meeting-files.ts';
import type { LoadedAutomation } from './load-automations.ts';
import { createRulesTakeCache, meetingsTheRulesTake } from './post-processing-ledger.ts';

/**
 * #637 attack, design 2: which meetings the rules that write summaries take,
 * by their own queries asked of the index — over the fake vault whose index
 * answers with real SQL. Fictional names only.
 */

const TODAY = '2026-10-29';
const STANDUP = 'Meetings/2026/10/2026-10-28 Standup.md';
const ONE_ON_ONE = 'Meetings/2026/10/2026-10-28 Mara and Tobias.md';
const OLD = 'Meetings/2026/09/2026-09-01 Kickoff.md';
const TYPES = [
  ...TASK_TYPES,
  parseObjectType({
    name: 'meeting',
    label: 'Meeting',
    properties: { date: 'date', kind: 'text' },
  }),
];

const meeting = (externalId: string, date: string, kind: string) =>
  jsonNote(
    { ...MEETING_HEADER, external_id: externalId, date, kind, atlas_import_outcome: 'imported' },
    MEETING_BODY,
  );

const rule = (which: string, id = 'after-a-meeting'): LoadedAutomation => ({
  rule: {
    id,
    path: createVaultPath(`.atlas/automations/${id}.md`),
    name: 'After a meeting',
    enabled: true,
    when: { kind: 'note', type: 'meeting', on: ['created'] },
    which,
    olderThanDays: null,
    action: {
      kind: 'claude',
      prompt: AFTER_A_MEETING_PROMPT,
      tools: [],
      output: { kind: 'proposals', schema: 'meeting-digest' },
      apply: 'mine',
    },
  } satisfies AutomationRule,
  log: [],
  ledger: null,
  idWritten: true,
});

function setUp() {
  const vault = automationVault({
    notes: {
      [STANDUP]: meeting('m-1', '2026-10-28', 'standup'),
      [ONE_ON_ONE]: meeting('m-2', '2026-10-28', 'one-on-one'),
      [OLD]: meeting('m-3', '2026-09-01', 'standup'),
    },
    today: TODAY,
    types: TYPES,
  });
  const queries = { count: 0 };
  const index = {
    ...vault.ports.index,
    query: async (sql: string, parameters: readonly (string | number | null)[]) => {
      queries.count += 1;
      return vault.ports.index.query(sql, parameters);
    },
  };
  const ports = { ...vault.ports, types: TYPES, index };
  const paths = [STANDUP, ONE_ON_ONE, OLD].map(createVaultPath);
  return { ports, paths, queries };
}

describe('meetingsTheRulesTake (#637 attack)', () => {
  it('takes what the rule’s own query takes, among the meetings asked about, with the 14 days', async () => {
    const { ports, paths } = setUp();

    const taken = await meetingsTheRulesTake({
      ports,
      automations: [rule('FROM meeting WHERE date >= @-14d AND kind = "standup"')],
      todayOf: () => TODAY,
      paths,
    });

    expect(taken).toEqual({ paths: new Set([STANDUP]), from: '2026-10-15' });
  });

  it('takes what any rule that writes summaries takes, and asks nothing for one that does not', async () => {
    const { ports, paths, queries } = setUp();
    const proposing = rule('FROM meeting', 'proposals-only');
    const notMine: LoadedAutomation = {
      ...proposing,
      rule: {
        ...proposing.rule,
        action: {
          kind: 'claude',
          prompt: AFTER_A_MEETING_PROMPT,
          tools: [],
          output: { kind: 'proposals', schema: 'meeting-digest' },
        },
      },
    };

    const taken = await meetingsTheRulesTake({
      ports,
      automations: [
        rule('FROM meeting WHERE kind = "standup" AND date >= @-14d'),
        rule('FROM meeting WHERE kind = "one-on-one"', 'one-on-ones'),
        notMine,
      ],
      todayOf: () => TODAY,
      paths,
    });

    expect(taken?.paths).toEqual(new Set([STANDUP, ONE_ON_ONE]));
    expect(queries.count).toBe(2);
  });

  it('asks nothing with no meeting to ask about, or no rule that writes summaries', async () => {
    const { ports, paths, queries } = setUp();

    expect(
      await meetingsTheRulesTake({
        ports,
        automations: [rule('FROM meeting')],
        todayOf: () => TODAY,
        paths: [],
      }),
    ).toEqual({ paths: new Set(), from: '2026-10-15' });
    expect(
      await meetingsTheRulesTake({ ports, automations: [], todayOf: () => TODAY, paths }),
    ).toEqual({
      paths: new Set(),
      from: '',
    });
    expect(queries.count).toBe(0);
  });

  it('says it cannot tell when the index refuses, or the query does not read', async () => {
    const { ports, paths } = setUp();
    const failing = {
      ...ports,
      index: { ...ports.index, query: async () => Promise.reject(new Error('index not open')) },
    };

    expect(
      await meetingsTheRulesTake({
        ports: failing,
        automations: [rule('FROM meeting')],
        todayOf: () => TODAY,
        paths,
      }),
    ).toBeNull();
    expect(
      await meetingsTheRulesTake({
        ports,
        automations: [rule('FROM meeting WHERE (')],
        todayOf: () => TODAY,
        paths,
      }),
    ).toBeNull();
  });
});

describe('createRulesTakeCache (#637 attack)', () => {
  it('asks once for the same rules, day, meetings and generation, and again when any moves', async () => {
    const { ports, paths, queries } = setUp();
    const take = createRulesTakeCache();
    const asked = { ports, automations: [rule('FROM meeting')], todayOf: () => TODAY, paths };

    await take({ ...asked, generation: 1 });
    await take({ ...asked, generation: 1 });
    expect(queries.count).toBe(1);

    await take({ ...asked, generation: 2 });
    expect(queries.count).toBe(2);
    await take({ ...asked, generation: 2, todayOf: () => '2026-10-30' });
    expect(queries.count).toBe(3);
    await take({ ...asked, generation: 2, todayOf: () => '2026-10-30', paths: paths.slice(1) });
    expect(queries.count).toBe(4);
  });

  it('asks again when the ports it is asked through move: the types or the notes may have', async () => {
    const { ports, paths, queries } = setUp();
    const take = createRulesTakeCache();
    const asked = { automations: [rule('FROM meeting')], todayOf: () => TODAY, paths, generation: 1 };

    await take({ ...asked, ports });
    await take({ ...asked, ports });
    expect(queries.count).toBe(1);

    await take({ ...asked, ports: { ...ports, notePaths: [...ports.notePaths] } });
    expect(queries.count).toBe(2);
  });

  it('asks again after an answer the index could not give', async () => {
    const { ports, paths } = setUp();
    let refuse = true;
    let asks = 0;
    const flaky = {
      ...ports,
      index: {
        ...ports.index,
        query: async (sql: string, parameters: readonly (string | number | null)[]) => {
          asks += 1;
          if (refuse) throw new Error('index not open');
          return ports.index.query(sql, parameters);
        },
      },
    };
    const take = createRulesTakeCache();
    const asked = {
      ports: flaky,
      automations: [rule('FROM meeting')],
      todayOf: () => TODAY,
      paths,
      generation: 1,
    };

    expect(await take(asked)).toBeNull();
    refuse = false;
    expect((await take(asked))?.paths.size).toBe(3);
    expect(asks).toBe(2);
  });
});
