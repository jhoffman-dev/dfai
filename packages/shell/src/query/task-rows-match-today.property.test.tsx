// @vitest-environment jsdom
/**
 * Attack on PR #625 (#107): over seeded task files — every status, date and
 * recurrence shape, CRLF, a BOM, comments in the frontmatter — each action a
 * row offers, made from a query view's row and from a Today row, leaves the
 * file byte for byte the same, and the same as the rule written once
 * through the plain property write (the oracle).
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  createVaultPath,
  focusIsOwn,
  indexedTexts,
  REVIEW_PROJECTS_QUERY_MARK,
  REVIEW_TASKS_QUERY_MARK,
  splitFrontmatter,
  TASK_ROW_COLUMNS,
  TASK_TYPE_FILE,
  taskAsRead,
  taskRowFacts,
  taskRowState,
  TODAY_MOVES,
  type GtdStatus,
} from '@dfai/domain';
import {
  fakeIndexPort,
  fakeVaultFs,
  memoryVault,
  recordingActivity,
  setNoteProperties,
  taskRowChange,
  type QueryResult,
  type TaskRowAction,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useToday } from '../today/use-today.ts';
import { useTaskRows } from './use-task-rows.ts';

const TODAY = '2026-10-28';
const NOW = Date.UTC(2026, 9, 28, 15);
const CLOCK = { today: () => TODAY, now: () => NOW };
const PATH = createVaultPath('Tasks/Feed the hens.md');
const TITLE = 'Feed the hens';
const TYPES = [TASK_TYPE_FILE.type];
const noPane = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const STATUS = [
  'status: next-action',
  'status: "waiting"',
  "status: 'in-progress' # moving",
  'status: someday ',
  'status: [next-action]',
  'status:\n  - inbox',
  'status: archive',
  'status:',
  'status: ""',
  'status: Next-Action',
  'status: [[waiting]]',
];
const DUE = [
  '',
  'due: 2026-10-28',
  'due: 2026-10-31 # month end',
  'due: "2026-12-31"',
  'due: 2026-02-28T09:00',
  'due: soon',
];
const DEFER = ['', 'defer: 2026-10-20', 'defer: [2026-11-01]'];
const FOCUS = ['', `focus: ${TODAY}`, 'focus: 2026-10-27', 'focus: the garden', 'focus:'];
const RECURRENCE = [
  '',
  'recurrence: every day',
  'recurrence: every week',
  'recurrence: every 2 weeks',
  'recurrence: every month',
  'recurrence: every year',
  'recurrence: weekly',
  'recurrence: every 3 months',
];

function fileOf(next: () => number): string {
  const pick = (shapes: readonly string[]) => shapes[Math.floor(next() * shapes.length)] ?? '';
  const lines = [
    'type: task',
    pick(STATUS),
    pick(DUE),
    pick(DEFER),
    pick(FOCUS),
    pick(RECURRENCE),
  ].filter((line) => line !== '');
  if (next() < 0.3) lines.splice(1, 0, '# a comment line');
  let text = ['---', ...lines, '---', '', '# Feed the hens', ''].join('\n');
  if (next() < 0.3) text = text.replaceAll('\n', '\r\n');
  if (next() < 0.2) text = `\uFEFF${text}`;
  return text;
}

const propertiesOf = (text: string) => {
  const { frontmatter } = splitFrontmatter(text);
  return frontmatter === null ? {} : remarkMarkdown.frontmatterProperties(frontmatter);
};

/** One item's text, as `singleTextSql` reads the index: null for none, several, or a nested map. */
function singleText(value: unknown): string | null {
  const items = indexedTexts(value);
  const only = items[0];
  if (items.length !== 1 || only === undefined) return null;
  return typeof value === 'object' && !Array.isArray(value) ? null : only;
}

function hiddenOf(text: string) {
  const properties = propertiesOf(text);
  const read = taskAsRead(properties);
  return {
    [TASK_ROW_COLUMNS.status]: read.status,
    [TASK_ROW_COLUMNS.due]: read.due,
    [TASK_ROW_COLUMNS.defer]: read.defer,
    [TASK_ROW_COLUMNS.focus]: read.focus,
    [TASK_ROW_COLUMNS.focusIsOwn]: focusIsOwn(properties) ? 1 : 0,
    [TASK_ROW_COLUMNS.recurrence]: singleText(properties['recurrence']),
  };
}

type Pressed =
  | { readonly kind: 'done' }
  | { readonly kind: 'move'; readonly status: GtdStatus }
  | { readonly kind: 'choose' | 'unchoose' };

function actionOf(press: Pressed): TaskRowAction {
  if (press.kind === 'done' || press.kind === 'move') return press;
  return { kind: 'choice', choice: press.kind, today: TODAY };
}

/** What a row offers, as its controls draw it, among what Today offers too. */
function offered(text: string): Pressed[] {
  const state = taskRowState(hiddenOf(text)) ?? expect.fail('no state');
  const facts = taskRowFacts({ state, today: TODAY, choosing: true });
  return [
    ...(facts.done ? [] : [{ kind: 'done' } as const]),
    ...facts.moves
      .filter((status) => TODAY_MOVES.includes(status))
      .map((status) => ({ kind: 'move', status }) as const),
    ...(facts.chosen === false ? [{ kind: 'choose' } as const] : []),
    ...(facts.chosen === true ? [{ kind: 'unchoose' } as const] : []),
  ];
}

const settle = async () => {
  for (let turn = 0; turn < 20; turn += 1) await act(async () => await Promise.resolve());
};

async function oracle(text: string, press: Pressed): Promise<string | undefined> {
  const memory = memoryVault({ [PATH]: text });
  await setNoteProperties({
    fs: fakeVaultFs(memory.fs),
    markdown: remarkMarkdown,
    path: PATH,
    values: taskRowChange(actionOf(press)),
    today: TODAY,
  });
  return memory.files.get(PATH);
}

async function fromToday(text: string, press: Pressed): Promise<string | undefined> {
  const memory = memoryVault({ [PATH]: text });
  const hidden = hiddenOf(text);
  const answer = (sql: string): QueryResult => {
    if (sql.startsWith(REVIEW_TASKS_QUERY_MARK)) {
      return {
        columns: [
          'path',
          'title',
          'modified',
          'status',
          'due',
          'defer',
          'focus',
          'focusIsOwn',
          'recurrence',
        ],
        rows: [[PATH, TITLE, NOW, ...Object.values(hidden)]],
        truncated: false,
      };
    }
    if (sql.startsWith(REVIEW_PROJECTS_QUERY_MARK)) {
      return { columns: ['path', 'title', 'status', 'moving'], rows: [], truncated: false };
    }
    return { columns: ['path', 'title', 'type'], rows: [], truncated: false };
  };
  const options = {
    ports: {
      index: fakeIndexPort({ query: async (sql: string) => answer(sql) }),
      fs: fakeVaultFs(memory.fs),
      markdown: remarkMarkdown,
    },
    editors: noPane,
    activity: recordingActivity(),
    clock: CLOCK,
    types: TYPES,
    vaultKey: 'vault-a',
    indexKey: 'ready:1',
    indexKeyNow: () => 'ready:1',
    open: true,
    onSettled: () => {},
  };
  const hook = renderHook(() => useToday(options));
  await waitFor(() => expect(hook.result.current.page.today).not.toBeNull());
  const page = hook.result.current.page;
  const row = { path: PATH, title: TITLE };
  act(() => {
    if (press.kind === 'done') page.onDone(row);
    else if (press.kind === 'move') page.onSetStatus({ ...row, status: press.status });
    else page.onChoose({ ...row, choice: press.kind });
  });
  await settle();
  hook.unmount();
  return memory.files.get(PATH);
}

async function fromQueryView(text: string, press: Pressed): Promise<string | undefined> {
  const memory = memoryVault({ [PATH]: text });
  const row = { path: PATH, title: TITLE, values: { type: 'task', ...hiddenOf(text) } };
  const options = {
    rows: [row],
    read: { at: 1, indexKey: 'ready:1' },
    runsBegun: () => 1,
    indexKeyNow: () => 'ready:1',
    enabled: true,
    scope: ['index', 'Views/Next actions.md'],
    ports: {
      fs: fakeVaultFs(memory.fs),
      markdown: remarkMarkdown,
      editors: noPane,
      activity: recordingActivity(),
    },
    clock: CLOCK,
    types: TYPES,
    onChanged: () => {},
  };
  const hook = renderHook(() => useTaskRows(options));
  const controls = hook.result.current.controls ?? expect.fail('no controls');
  act(() => {
    if (press.kind === 'done') controls.onDone(row, true);
    else if (press.kind === 'move') controls.onMove(row, press.status);
    else controls.onToday(row, press.kind === 'unchoose');
  });
  await settle();
  hook.unmount();
  return memory.files.get(PATH);
}

const CASES = (() => {
  const next = rng(625);
  const cases: { text: string; press: Pressed }[] = [];
  while (cases.length < 60) {
    const text = fileOf(next);
    const offers = offered(text);
    const press = offers[Math.floor(next() * offers.length)];
    if (press !== undefined) cases.push({ text, press });
  }
  return cases;
})();

describe('a query row, a Today row and the rule written once agree byte for byte (PR #625)', () => {
  it.each(CASES.map((each, at) => [at, JSON.stringify(each.press), each] as const))(
    'case %i: %s',
    async (_at, _name, { text, press }) => {
      const expected = await oracle(text, press);
      expect(await fromQueryView(text, press)).toBe(expected);
      expect(await fromToday(text, press)).toBe(expected);
    },
  );

  it('ticks an open task offered a tick to Archive or a roll, never leaving it open as it was', async () => {
    for (const { text, press } of CASES.filter((each) => each.press.kind === 'done')) {
      const after = (await fromQueryView(text, press)) ?? '';
      expect(after, text).not.toBe(text);
    }
  });
});
