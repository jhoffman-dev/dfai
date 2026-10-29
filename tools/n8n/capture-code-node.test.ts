import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CaptureRefusedError, mapCapture as mapDomainCapture } from '@dfai/domain';
import { writeCaptureMarkdown } from '../../packages/adapters/src/markdown/capture-markdown.ts';
import { bundleCaptureMarkdown, CAPTURE_MARKDOWN_BUNDLE } from './capture-bundle.ts';
import {
  hostileText,
  seededRandom,
  slackCapture,
  slackSource,
} from '../../packages/domain/src/testing/index.ts';
import { captureCodeNodeScript, mapCaptureScript } from './code-node.ts';

/*
 * The Slack capture mapper (#103) compiled for n8n's Code node (#104): one
 * script, no imports, writing the same bytes the app writes — in Node, as
 * n8n runs it, and in JavaScriptCore, the app's webview, so a capture
 * mapped by either is one file and never a sync conflict copy (ADR-0034).
 */

const mapping = new URL('../../packages/domain/src/capture/mapping/', import.meta.url);
const modules = readdirSync(mapping).filter(
  (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
);
const OPTIONS = { timeZone: 'America/Los_Angeles' };
const RUN = `return mapCapture($json, { ...${JSON.stringify(OPTIONS)}, writeMarkdown: dfaiCaptureMarkdown.writeCaptureMarkdown });`;

/** The capture mapped as the app maps it: the domain's mapper, the adapters' writer. */
const mapCapture = (payload: unknown, options: typeof OPTIONS = OPTIONS) =>
  mapDomainCapture(payload, { ...options, writeMarkdown: writeCaptureMarkdown });

describe('the capture mapper compiled into a Code node', () => {
  it('holds the writer bundled from the app’s own, up to date (`pnpm n8n:build`)', async () => {
    expect(readFileSync(CAPTURE_MARKDOWN_BUNDLE, 'utf8')).toBe(await bundleCaptureMarkdown());
  }, 60_000);

  it.each(modules)('%s imports nothing but its own modules and the meeting mapper’s', (name) => {
    const text = readFileSync(new URL(name, mapping), 'utf8');
    const sources = [...text.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((each) => each[1]);
    for (const source of sources) {
      expect(source).toMatch(
        /^\.\/capture-[a-z-]+\.ts$|^\.\.\/\.\.\/meetings\/mapping\/meeting-[a-z-]+\.ts$/,
      );
    }
  });

  it('is every module in the folder, and every meeting module they import, so none is left out', () => {
    const script = mapCaptureScript();
    for (const name of modules) expect(script).toContain(`// ${name}\n`);
    const shared = modules.flatMap((name) =>
      [
        ...readFileSync(new URL(name, mapping), 'utf8').matchAll(
          /meetings\/mapping\/(meeting-[a-z-]+\.ts)/g,
        ),
      ].map((each) => each[1]),
    );
    for (const name of shared) expect(script).toContain(`// ${name}\n`);
  });

  it('runs in Node as n8n runs it, writing what the app writes', () => {
    const inNode = new Function('$json', captureCodeNodeScript(RUN)) as (json: unknown) => unknown;
    expect(inNode(slackCapture())).toEqual({ ...mapCapture(slackCapture(), OPTIONS) });
  });

  it('is refused there as it is in the app, every reason named', () => {
    const inNode = new Function('$json', captureCodeNodeScript(RUN)) as (json: unknown) => unknown;
    expect(() => inNode(slackCapture({ kind: 'memo' }))).toThrow(
      /kind: "memo" is not "note" or "task"/,
    );
    expect(() => mapCapture(slackCapture({ kind: 'memo' }))).toThrow(CaptureRefusedError);
  });

  it('wraps the node’s answer for n8n', () => {
    const node = new Function('$json', mapCaptureScript()) as (json: unknown) => { json: unknown };
    expect(node(slackCapture()).json).toEqual({ ...mapCapture(slackCapture(), OPTIONS) });
  });
});

const JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc';

/** Hostile captures, built from a seed: the same list in every engine. */
function hostileCaptures(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, at) => {
    const random = seededRandom(at + 1);
    return slackCapture({
      kind: random() < 0.5 ? 'note' : 'task',
      title: random() < 0.3 ? hostileText(random, 8) : null,
      text: hostileText(random, 40),
      source: slackSource({
        author: { name: hostileText(random, 6), email: 'mara.quill@example.com' },
      }),
      thread: [
        {
          ts: '1793136300.000200',
          author: { name: hostileText(random, 4) },
          text: hostileText(random, 20),
        },
      ],
    });
  });
}

/** Each capture's file, or its refusal, as the compiled script answers under JavaScriptCore. */
function inJavaScriptCore(captures: readonly unknown[]): unknown[] {
  const dir = mkdtempSync(join(tmpdir(), 'dfai-capture-jsc-'));
  const driver = [
    `function mapInNode($json) {\n${captureCodeNodeScript(RUN)}\n}`,
    `const captures = ${JSON.stringify(captures)};`,
    'print(JSON.stringify(captures.map((each) => { try { return mapInNode(each); } catch (error) { return `${error.name}: ${error.message}`; } })));',
  ].join('\n');
  const file = join(dir, 'driver.js');
  try {
    writeFileSync(file, driver);
    return JSON.parse(
      execFileSync(JSC, [file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
    ) as unknown[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function inApp(capture: unknown): unknown {
  try {
    return { ...mapCapture(capture, OPTIONS) };
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

// Only where macOS's jsc is: CI's Linux unit shards skip it, and the test below says so in
// their output. Run tools/n8n on a Mac after changing the mapper (tools/n8n/README.md).
describe('where the parity test runs', () => {
  it.runIf(!existsSync(JSC))(
    'says JavaScriptCore parity is not checked here: jsc is macOS’s',
    () => {
      expect(existsSync(JSC)).toBe(false);
    },
  );
});

describe.skipIf(!existsSync(JSC))('a capture mapped in the webview’s engine', () => {
  it('writes the fixture, a refusal and 200 hostile captures byte for byte as Node does', () => {
    const captures = [slackCapture(), slackCapture({ kind: 'memo' }), ...hostileCaptures(200)];
    expect(inJavaScriptCore(captures)).toEqual(captures.map(inApp));
  });
});
