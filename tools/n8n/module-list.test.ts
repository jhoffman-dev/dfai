import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPTURE_MODULES, MAP_CAPTURE_EXTRA, MODULES } from './code-node.ts';
import { WEBHOOK_MODULES } from './granola-code-node.ts';
import { CAPTURE_MARKDOWN_GLOBAL } from './capture-bundle.ts';
import { moduleListProblems } from './module-list.ts';
import type { NodeMode } from './node-script-host.ts';
import {
  CAPTURE_MODULES as SLACK_CAPTURE_MODULES,
  REPLY_MODULES,
  VERIFY_MODULES,
} from './slack-code-node.ts';

/*
 * Each Code node's modules are listed by hand (#825). Every Code node in the
 * built workflows is matched to the list it was built from, and every list is
 * checked against its modules' imports and the lines of the nodes that use it.
 */

const LISTS = {
  'the meeting mapper': MODULES,
  'the capture mapper': [...CAPTURE_MODULES, ...MAP_CAPTURE_EXTRA],
  'the Granola signature check': WEBHOOK_MODULES,
  'the Slack signature check': VERIFY_MODULES,
  'the Slack capture payload': SLACK_CAPTURE_MODULES,
  'a Slack reply': REPLY_MODULES,
} satisfies Record<string, readonly string[]>;

type ListName = keyof typeof LISTS;
const LIST_NAMES = Object.keys(LISTS) as ListName[];

const RUN = '// --- n8n ---\n';
const BLOCK = /^\/\/ ([\w.-]+\.ts)\nconst \{/gm;

interface CodeNode {
  readonly name: string;
  readonly modules: string;
  readonly run: string;
  readonly mode: NodeMode;
}

/** Every Code node `pnpm n8n:build` wrote that carries modules: what it holds, and its own lines. */
function builtCodeNodes(): CodeNode[] {
  const folder = new URL('./', import.meta.url);
  return readdirSync(folder)
    .filter((file) => file.endsWith('.workflow.json'))
    .flatMap((file) => {
      const workflow = JSON.parse(readFileSync(new URL(file, folder), 'utf8')) as {
        nodes: { name: string; parameters?: { jsCode?: string; mode?: NodeMode } }[];
      };
      return workflow.nodes.flatMap(({ name, parameters }) => {
        const code = parameters?.jsCode;
        if (code === undefined || !code.includes(RUN)) return [];
        const at = code.indexOf(RUN);
        const run = code.slice(at + RUN.length);
        const modules = [...code.slice(0, at).matchAll(BLOCK)].map((each) => each[1]).join(', ');
        const mode = parameters?.mode ?? 'runOnceForAllItems';
        return [{ name: `${file} › ${name}`, modules, run, mode }];
      });
    });
}

const baseNames = (list: readonly string[]) =>
  list.map((each) => each.slice(each.lastIndexOf('/') + 1)).join(', ');

const listOf = (node: CodeNode) =>
  LIST_NAMES.find((each) => baseNames(LISTS[each]) === node.modules);

/** The built nodes, by the list they carry. */
function nodesByList(nodes: readonly CodeNode[]): Map<string, CodeNode[]> {
  const byList = new Map<string, CodeNode[]>(LIST_NAMES.map((list) => [list, []]));
  for (const node of nodes) byList.get(listOf(node) ?? '')?.push(node);
  return byList;
}

/*
 * The first check in a process pays for TypeScript's start-up (about half a
 * second idle, several under load): paid here, so no test's time carries it.
 */
beforeAll(() => {
  moduleListProblems([], []);
}, 30_000);

describe('the module list of every Code node the build makes', () => {
  const nodes = builtCodeNodes();
  const byList = nodesByList(nodes);

  it('matches every built Code node to the list it was built from', () => {
    expect(nodes.length).toBeGreaterThan(0);
    const unnamed = nodes.filter((node) => listOf(node) === undefined);
    expect(unnamed.map((node) => `${node.name}: ${node.modules}`)).toEqual([]);
  });

  it.each(LIST_NAMES)('%s is carried by a built node', (list) => {
    expect(byList.get(list)?.length).toBeGreaterThan(0);
  });

  it.each(LIST_NAMES)('%s is run in one mode by every node that carries it', (list) => {
    expect(new Set(byList.get(list)?.map(({ mode }) => mode)).size).toBe(1);
  });

  it.each(LIST_NAMES)(
    '%s holds every module its nodes need, read before it loads, and none unused',
    (list) => {
      const nodes = byList.get(list) ?? [];
      const check = {
        provided: list === 'the capture mapper' ? [CAPTURE_MARKDOWN_GLOBAL] : [],
        mode: nodes[0]?.mode ?? 'runOnceForAllItems',
      };
      const runs = nodes.map(({ run }) => run);
      expect(moduleListProblems(LISTS[list], runs, check)).toEqual([]);
    },
  );
});

/** A fixture module in a folder of its own, named by the absolute path a list may hold. */
const folder = mkdtempSync(join(tmpdir(), 'module-list-'));
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});
function fixture(file: string, text: string): string {
  writeFileSync(join(folder, file), text);
  return join(folder, file);
}

describe('the module-list check', () => {
  const RUN_LINES = [
    'const { delivery, check } = $json;\nreturn verifyStandardWebhook(delivery, check);',
  ];

  it('passes a list that holds what its modules import, in order', () => {
    expect(moduleListProblems(['./sha256.ts', './standard-webhook.ts'], RUN_LINES)).toEqual([]);
  });

  it('names a module that is imported but missing from the list, and what to do', () => {
    expect(moduleListProblems(['./standard-webhook.ts'], RUN_LINES)).toEqual([
      expect.stringMatching(
        /^\.\/standard-webhook\.ts: Cannot find name 'hmacSha256'\. \(list the module that exports it/,
      ),
    ]);
  });

  it('passes a module listed after one that uses it only once the node runs', () => {
    expect(moduleListProblems(['./standard-webhook.ts', './sha256.ts'], RUN_LINES)).toEqual([]);
  });

  // A read through the reader's own function called at load (`export const TWO = h()`) is not
  // caught: the compiler does not follow calls. So "before" is held only for direct reads.
  it('names a module listed after one that reads it directly while the modules load (not through a call)', () => {
    const base = fixture('load-base.ts', 'export function one(): number {\n  return 1;\n}\n');
    const early = fixture(
      'load-early.ts',
      "import { one } from './load-base.ts';\nexport const TWO = one() + 1;\n",
    );
    expect(moduleListProblems([early, base], ['return TWO;'])).toEqual([
      expect.stringMatching(
        /load-early\.ts: Block-scoped variable 'one' used before its declaration/,
      ),
    ]);
  });

  it('names a module listed that nothing imports and no node uses', () => {
    const list = ['./sha256.ts', './standard-webhook.ts', './slack-reply.ts'];
    expect(moduleListProblems(list, RUN_LINES)).toEqual([
      './slack-reply.ts is listed, but no listed module imports it and no node uses it',
    ]);
  });

  it('counts a module as used when a node calls one of its exports by name', () => {
    expect(moduleListProblems(['./slack-reply.ts'], ['return savedReply($json);'])).toEqual([]);
  });

  it('does not count a name in a comment or a string as a use', () => {
    const run = "// savedReply($json)\nreturn 'savedReply';";
    expect(moduleListProblems(['./slack-reply.ts'], [run])).toEqual([
      './slack-reply.ts is listed, but no listed module imports it and no node uses it',
    ]);
  });

  it('names what the node uses that no listed module exports, unless something else provides it', () => {
    const run = 'return savedReply(dfaiCaptureMarkdown);';
    expect(moduleListProblems(['./slack-reply.ts'], [run])).toEqual([
      expect.stringMatching(/^the node’s own lines: Cannot find name 'dfaiCaptureMarkdown'\./),
    ]);
    expect(
      moduleListProblems(['./slack-reply.ts'], [run], { provided: ['dfaiCaptureMarkdown'] }),
    ).toEqual([]);
  });

  describe('needs no module for an import that is only a type', () => {
    fixture('shape.ts', 'export interface Shape {\n  n: number;\n}\nexport const UNIT = 1;\n');
    const size = 'export function size(s: Shape): number {\n  return s.n;\n}\n';
    it.each([
      ['import type', "import type { Shape } from './shape.ts';\n"],
      ['every name marked type', "import { type Shape } from './shape.ts';\n"],
      ['an unmarked name used only as a type', "import { Shape } from './shape.ts';\n"],
      [
        'a type re-exported',
        "import type { Shape } from './shape.ts';\nexport { type Shape as Form } from './shape.ts';\n",
      ],
    ])('%s', (form, imports) => {
      const user = fixture(`${form.replaceAll(' ', '-')}.ts`, `${imports}${size}`);
      expect(moduleListProblems([user], ['return size({ n: 3 });'])).toEqual([]);
    });
  });

  describe('names each import or export the build cannot inline, and what to do', () => {
    const base = fixture('base.ts', 'export function one(): number {\n  return 1;\n}\n');
    const use = '\nexport function two(): number {\n  return 2;\n}\n';
    it.each([
      ['renamed', "import { one as uno } from './base.ts';\nuno();", /Cannot find name 'uno'/],
      ['namespace', "import * as b from './base.ts';\nb.one();", /Cannot find name 'b'/],
      ['default', "import uno from './base.ts';\nuno();", /Cannot find name 'uno'/],
      ['re-export', "export { one } from './base.ts';", /export declaration/],
      ['star', "export * from './base.ts';", /export declaration/],
      ['list', 'const three = 3;\nexport { three };', /export declaration/],
      ['default-export', 'export default 3;', /export assignment|top level/],
      ['enum', 'export enum Size {\n  S,\n}', /Modifiers cannot appear here/],
      ['dynamic', "export const later = () => import('./base.ts');", /at run time/],
      ['require', "export const now = () => require('./base.ts');", /at run time/],
    ])('%s', (form, lines, why) => {
      const module = fixture(`form-${form}.ts`, `${lines}${use}`);
      const problem = moduleListProblems([base, module], ['return two() + one();']).find((each) =>
        why.test(each),
      );
      expect(problem).toMatch(new RegExp(`^${module}: `));
      expect(problem).toMatch(
        /\((list the module|the build inlines only)|; the build inlines only/,
      );
    });
  });

  it('still needs the module when one name of the import is a value', () => {
    fixture('shape.ts', 'export interface Shape {\n  n: number;\n}\nexport const UNIT = 1;\n');
    const user = fixture(
      'unit-user.ts',
      "import { type Shape, UNIT } from './shape.ts';\nexport function size(s: Shape): number {\n  return s.n * UNIT;\n}\n",
    );
    expect(moduleListProblems([user], ['return size({ n: 3 });'])).toEqual([
      expect.stringMatching(/unit-user\.ts: Cannot find name 'UNIT'/),
    ]);
  });
});

/*
 * Re-check of #847: node code that is correct in n8n must pass, and modules
 * the build turns into a broken script must not.
 */
describe('the module-list check against what n8n runs (re-check #847)', () => {
  const A = fixture('twice.ts', 'export function twice(n: number): number {\n  return n * 2;\n}\n');

  it.each([
    [
      'a class the lines declare',
      'class Acc {\n  constructor() {\n    this.n = twice(1);\n  }\n}\nreturn new Acc();',
    ],
    ['a method of an object', 'return { toJSON() { return twice(1); } };'],
    ['a getter of an object', 'return { get size() { return twice(1); } };'],
    [
      'class fields and methods',
      'class B {\n  n = 1;\n  m() { return twice(this.n); }\n}\nreturn new B().m();',
    ],
    [
      'a named function expression',
      'const f = function again(n) { return n > 0 ? again(n - 1) : twice(n); };\nreturn f(2);',
    ],
    ['arguments', 'return (function () { return twice(arguments.length); })(1);'],
    ['typeof a name nothing declares', "return typeof maybe === 'undefined' ? twice(1) : 0;"],
    ['n8n’s DateTime', 'return twice(DateTime.now().year);'],
  ])('passes node lines using %s', (_, run) => {
    expect(moduleListProblems([A], [run])).toEqual([]);
  });

  it.each([
    ['a destructured export', 'export const { a } = { a: 1 };\n', 'a'],
    ['import.meta', 'export const here = (): string => import.meta.url;\n', 'here'],
    ['a top-level await', 'export const v = await Promise.resolve(1);\n', 'v'],
    [
      'a top-level for await',
      'for await (const each of [1]) console.log(each);\nexport const v = 1;\n',
      'v',
    ],
    ['an export declare', 'export declare const v: number;\n', 'v'],
  ])('reports a module with %s, by name', (form, text, name) => {
    const module = fixture(`broken-${form.replaceAll(' ', '-')}.ts`, text);
    const problems = moduleListProblems([module], [`return ${name};`]);
    expect(problems.filter((each) => !each.includes(' is listed, but '))).toContainEqual(
      expect.stringMatching(new RegExp(`^${module}: `)),
    );
  });

  it.each(['expect', 'vi', 'process', 'fetch', 'constructor'])(
    'reports %s, which the test runner has but n8n does not',
    (name) => {
      expect(moduleListProblems([A], [`return twice(${name});`])).toEqual([
        expect.stringContaining(name),
      ]);
    },
  );

  it('reports a name used outside the scope that declares it', () => {
    const run = 'items.map((total) => total);\nreturn twice(total);';
    expect(moduleListProblems([A], [run])).toEqual([expect.stringContaining('total')]);
  });

  it('reports a name the node’s lines declare that a listed module also hands on', () => {
    // The build puts the lines in the modules' scope: n8n throws "Identifier 'twice' has already been declared".
    const both = fixture(
      'twice-thrice.ts',
      'export function twice(n: number): number {\n  return n * 2;\n}\nexport function thrice(n: number): number {\n  return n * 3;\n}\n',
    );
    expect(moduleListProblems([both], ['const twice = 1;\nreturn thrice(twice);'])).toContainEqual(
      expect.stringContaining('twice'),
    );
  });

  it.each([
    [
      'a class field read as a bare name',
      'class C {\n  x = 1;\n  m() { return twice(x); }\n}\nreturn new C().m();',
    ],
    ['a type read as a value', 'return twice(Partial);'],
  ])('reports %s, which throws a ReferenceError in n8n', (_, run) => {
    expect(moduleListProblems([A], [run])).not.toEqual([]);
  });

  it.each([
    ['items', 'runOnceForEachItem'],
    ['item', 'runOnceForAllItems'],
  ] as const)(
    'reports %s in a node run in %s mode, which n8n does not define there',
    (name, mode) => {
      expect(moduleListProblems([A], [`return twice(${name}.length);`], { mode })).toEqual([
        expect.stringContaining(`'${name}'`),
      ]);
      const other = mode === 'runOnceForAllItems' ? 'runOnceForEachItem' : 'runOnceForAllItems';
      expect(moduleListProblems([A], [`return twice(${name}.length);`], { mode: other })).toEqual(
        [],
      );
    },
  );

  describe('typeof of a name a module imports, against a name it probes for', () => {
    const b = fixture('guard-b.ts', "export function sign(): string {\n  return 'signed';\n}\n");
    // Read only under typeof: the call is not checked, so nothing but the import can say it is missing.
    const a = fixture(
      'guard-a.ts',
      "import { sign } from './guard-b.ts';\nexport const canSign = (): boolean => typeof sign === 'function';\n",
    );
    const run = 'return canSign();';

    it('reports the module it imports from when that is missing, though typeof hides the throw', () => {
      expect(moduleListProblems([a], [run])).toEqual([
        expect.stringMatching(/guard-a\.ts: Cannot find name 'sign'/),
      ]);
    });

    it('passes when the module it imports from is listed', () => {
      expect(moduleListProblems([b, a], [run])).toEqual([]);
    });

    it.each(['Buffer', 'someUndeclaredGlobal'])('passes a module that probes for %s', (name) => {
      const probe = fixture(
        `probe-${name}.ts`,
        `export const has = (): boolean => typeof ${name} === 'function';\n`,
      );
      expect(moduleListProblems([probe], ['return has();'])).toEqual([]);
    });
  });

  it('reports typeof of a name declared later in the same scope, which throws', () => {
    const run = 'const kind = typeof later;\nconst later = twice(1);\nreturn kind;';
    expect(moduleListProblems([A], [run])).toEqual([expect.stringContaining('later')]);
  });
});
