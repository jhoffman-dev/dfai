import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * Runs a Code node's script as n8n does, for the Slack workflow's tests:
 * `$input`, `$('<node>')`, `this.helpers.getBinaryDataBuffer` and a fixed
 * clock — in Node, and the same driver under JavaScriptCore, so a test can
 * require both engines to answer alike.
 */

export interface Item {
  readonly json: unknown;
}

export interface NodeRun {
  readonly jsCode: string;
  /** The node's input items. */
  readonly input: readonly Item[];
  /** Earlier nodes' items, by name, as `$('<name>')` reads them. */
  readonly nodes?: Readonly<Record<string, readonly Item[]>>;
  /** The raw body the Webhook node put in its `data` binary. */
  readonly binary?: readonly number[];
  /** Now, in milliseconds, as the script's `Date.now()` answers. */
  readonly now?: number;
}

/** The harness both engines run: n8n's names, given to the script as parameters. */
const HARNESS = `
async function runNode(run) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const items = run.input;
  const $input = { first: () => items[0], all: () => items };
  const $ = (name) => {
    const found = (run.nodes || {})[name];
    if (found === undefined) throw new Error('no node ' + name);
    return { first: () => found[0], item: found[0], all: () => found };
  };
  const helpers = { getBinaryDataBuffer: async () => Uint8Array.from(run.binary || []) };
  const FixedDate = class extends Date {
    static now() {
      return run.now;
    }
  };
  const node = new AsyncFunction('$input', '$', 'Date', run.jsCode);
  try {
    return { items: await node.call({ helpers }, $input, $, FixedDate) };
  } catch (error) {
    return { error: error.name + ': ' + error.message };
  }
}
`;

/** A node's answer: the items it returned, or the error it left by (name and message). */
export type NodeAnswer = { readonly items: readonly Item[] } | { readonly error: string };

/** One node run in Node, as n8n runs it. */
export async function runInNode(run: NodeRun): Promise<NodeAnswer> {
  const harness = new Function(`${HARNESS}\nreturn runNode;`) as () => (
    run: NodeRun,
  ) => Promise<NodeAnswer>;
  return JSON.parse(JSON.stringify(await harness()(run))) as NodeAnswer;
}

export const JSC =
  '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc';

/** Every run in JavaScriptCore, in order, answered as {@link runInNode} answers. */
export function runInJavaScriptCore(runs: readonly NodeRun[]): NodeAnswer[] {
  const dir = mkdtempSync(join(tmpdir(), 'dfai-slack-jsc-'));
  const driver = [
    HARNESS,
    `const runs = ${JSON.stringify(runs)};`,
    'const answers = [];',
    '(async () => { for (const run of runs) answers.push(await runNode(run)); })()',
    '  .then(() => print(JSON.stringify(answers)), (error) => print(JSON.stringify(String(error))));',
  ].join('\n');
  const file = join(dir, 'driver.js');
  try {
    writeFileSync(file, driver);
    return JSON.parse(
      execFileSync(JSC, [file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
    ) as NodeAnswer[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
