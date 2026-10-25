import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/*
 * The EPUB reader's frame script, made from its source (#505, ADR-0045).
 * The frame's policy runs one script, named by its SHA-256, so the script
 * is a fixed string, written into the frame as it is: this turns
 * `frame-bootstrap.ts` and the `text-positions.ts` and `unshadowed-dom.ts` it
 * uses into that string, in one closure, and writes it beside them with its
 * hash. A test makes it again and fails when the file written is not what
 * the sources make, so the frame never runs a script its source no longer
 * says.
 *
 *   node tools/epub/frame-bootstrap.ts
 */

const EPUB = join(dirname(fileURLToPath(import.meta.url)), '../../packages/adapters/src/epub');

/** The sources, in the order they are put together: each uses only those before it. */
const SOURCES = ['unshadowed-dom.ts', 'text-positions.ts', 'frame-bootstrap.ts'] as const;

/** The file written, which the reader imports. */
export const GENERATED = join(EPUB, 'frame-bootstrap.generated.ts');

/** The frame's script: the sources, without their imports and exports, started for the frame's own window. */
export function frameBootstrapScript(): string {
  const parts = SOURCES.map((name) => withoutModuleSyntax(name, transpiled(name)));
  const script = `(() => {\n'use strict';\n${parts.join('\n')}\nstartFrame(window, window.parent);\n})();\n`;
  // Written between `<script>` and `</script>` as it is: nothing in it may end the element.
  if (/<\/script|<!--/i.test(script)) throw new Error('the frame script would end its own element');
  return script;
}

function transpiled(name: string): string {
  const source = readFileSync(join(EPUB, name), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: false,
      removeComments: true,
    },
    fileName: name,
  }).outputText;
}

/** The module's code as plain statements: its imports are of the other sources, its exports only names. */
function withoutModuleSyntax(name: string, code: string): string {
  const lines = code.split('\n').filter((line) => line.trim() !== 'export {};');
  const kept = lines.filter((line) => {
    const imported = /^import .* from '\.\/([^']+)';$/.exec(line.trim());
    if (imported === null) return true;
    if (!(SOURCES as readonly string[]).includes(imported[1] ?? '')) {
      throw new Error(`${name} imports ${imported[1]}, which is not part of the frame script`);
    }
    return false;
  });
  const body = kept.join('\n').replace(/^export /gm, '');
  if (/^\s*(import|export)\b/m.test(body)) throw new Error(`${name} keeps an import or an export`);
  return body;
}

/** The SHA-256 of `script`, in base64, as a policy's `'sha256-…'` names it. */
export const sha256Base64 = (script: string): string =>
  createHash('sha256').update(script, 'utf8').digest('base64');

/** The generated file's whole text. */
export function frameBootstrapModule(): string {
  const script = frameBootstrapScript();
  return [
    '// Made by `node tools/epub/frame-bootstrap.ts` from frame-bootstrap.ts, text-positions.ts and unshadowed-dom.ts.',
    '// Do not edit: the frame runs this exactly, named by its hash (ADR-0045).',
    `export const FRAME_BOOTSTRAP = ${JSON.stringify(script)};`,
    `export const FRAME_BOOTSTRAP_SHA256 = '${sha256Base64(script)}';`,
    '',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(GENERATED, frameBootstrapModule());
  console.log(`wrote ${GENERATED}`);
}
