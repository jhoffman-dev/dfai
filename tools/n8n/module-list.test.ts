import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPTURE_MODULES, MAP_CAPTURE_EXTRA, MODULES } from './code-node.ts';
import { WEBHOOK_MODULES } from './granola-code-node.ts';
import { CAPTURE_MARKDOWN_GLOBAL } from './capture-bundle.ts';
import { moduleListProblems } from './module-list.ts';
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
}

/** Every Code node `pnpm n8n:build` wrote that carries modules: what it holds, and its own lines. */
function builtCodeNodes(): CodeNode[] {
  const folder = new URL('./', import.meta.url);
  return readdirSync(folder)
    .filter((file) => file.endsWith('.workflow.json'))
    .flatMap((file) => {
      const workflow = JSON.parse(readFileSync(new URL(file, folder), 'utf8')) as {
        nodes: { name: string; parameters?: { jsCode?: string } }[];
      };
      return workflow.nodes.flatMap(({ name, parameters }) => {
        const code = parameters?.jsCode;
        if (code === undefined || !code.includes(RUN)) return [];
        const at = code.indexOf(RUN);
        const run = code.slice(at + RUN.length);
        const modules = [...code.slice(0, at).matchAll(BLOCK)].map((each) => each[1]).join(', ');
        return [{ name: `${file} › ${name}`, modules, run }];
      });
    });
}

const baseNames = (list: readonly string[]) =>
  list.map((each) => each.slice(each.lastIndexOf('/') + 1)).join(', ');

const listOf = (node: CodeNode) =>
  LIST_NAMES.find((each) => baseNames(LISTS[each]) === node.modules);

/** The runs of every built node, by the list it carries. */
function runsByList(nodes: readonly CodeNode[]): Map<string, string[]> {
  const runs = new Map<string, string[]>(LIST_NAMES.map((list) => [list, [] as string[]]));
  for (const node of nodes) runs.get(listOf(node) ?? '')?.push(node.run);
  return runs;
}

describe('the module list of every Code node the build makes', () => {
  const nodes = builtCodeNodes();
  const runs = runsByList(nodes);

  it('matches every built Code node to the list it was built from', () => {
    expect(nodes.length).toBeGreaterThan(0);
    const unnamed = nodes.filter((node) => listOf(node) === undefined);
    expect(unnamed.map((node) => `${node.name}: ${node.modules}`)).toEqual([]);
  });

  it.each(LIST_NAMES)('%s is carried by a built node', (list) => {
    expect(runs.get(list)?.length).toBeGreaterThan(0);
  });

  it.each(LIST_NAMES)(
    '%s lists every module its modules import, before them, and none unused',
    (list) => {
      const provided = list === 'the capture mapper' ? [CAPTURE_MARKDOWN_GLOBAL] : [];
      expect(moduleListProblems(LISTS[list], runs.get(list) ?? [], provided)).toEqual([]);
    },
  );
});

/** A fixture module in a folder of its own, named by the absolute path a list may hold. */
const folder = mkdtempSync(join(tmpdir(), 'module-list-'));
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

  it('names a module that is imported but missing from the list', () => {
    expect(moduleListProblems(['./standard-webhook.ts'], RUN_LINES)).toEqual([
      './standard-webhook.ts imports sha256.ts, which is not listed before it',
    ]);
  });

  it('names a module listed after the module that imports it', () => {
    const problems = moduleListProblems(['./standard-webhook.ts', './sha256.ts'], RUN_LINES);
    expect(problems).toEqual([expect.stringContaining('sha256.ts, which is not listed before it')]);
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
      'the node uses dfaiCaptureMarkdown, which no listed module exports',
    ]);
    expect(moduleListProblems(['./slack-reply.ts'], [run], ['dfaiCaptureMarkdown'])).toEqual([]);
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

  describe('names each import or export the build cannot inline, and why', () => {
    const base = fixture('base.ts', 'export function one(): number {\n  return 1;\n}\n');
    const use = '\nexport function two(): number {\n  return 2;\n}\n';
    it.each([
      ['renamed', "import { one as uno } from './base.ts';\nuno();", /a renamed import/],
      ['namespace', "import * as b from './base.ts';\nb.one();", /a namespace import/],
      ['default', "import one from './base.ts';\none();", /a default import/],
      ['side-effect', "import './base.ts';", /side effects only/],
      ['re-export', "export { one } from './base.ts';", /re-export/],
      ['star', "export * from './base.ts';", /re-export/],
      ['list', 'const three = 3;\nexport { three };', /an export list/],
      ['default-export', 'export default 3;', /a default export/],
      ['enum', 'export enum Size {\n  S,\n}', /does not strip/],
      ['dynamic', "export const later = () => import('./base.ts');", /at run time/],
      ['require', "export const now = () => require('./base.ts');", /at run time/],
    ])('%s', (form, lines, why) => {
      const module = fixture(`form-${form}.ts`, `${lines}${use}`);
      const problems = moduleListProblems([base, module], ['return two() + one();']);
      expect(problems).toContainEqual(expect.stringMatching(why));
      expect(problems.find((each) => why.test(each))).toMatch(
        /; the (build inlines only|node is one script)/,
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
      expect.stringMatching(/unit-user\.ts imports .*shape\.ts, which is not listed before it$/),
    ]);
  });
});
