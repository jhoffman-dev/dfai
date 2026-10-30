import { readFileSync } from 'node:fs';
import ts from 'typescript';

/** Where the mapper lives: the domain, so the app's API maps a meeting by the same rules (#93). */
const MAPPING = '../../packages/domain/src/meetings/mapping/';

/**
 * The mapper's modules in the order a single script needs them: each after
 * what it uses, then the workflow's own GitHub checks. An n8n Code node is
 * one script with no imports, so the modules are joined into it; they import
 * nothing but each other.
 */
const MODULES = [
  `${MAPPING}meeting-mapping-error.ts`,
  `${MAPPING}meeting-instant.ts`,
  `${MAPPING}meeting-stated.ts`,
  `${MAPPING}meeting-when.ts`,
  `${MAPPING}meeting-punycode.ts`,
  `${MAPPING}meeting-email-key.ts`,
  `${MAPPING}meeting-attendees.ts`,
  `${MAPPING}meeting-text.ts`,
  `${MAPPING}meeting-sections.ts`,
  `${MAPPING}meeting-transcript.ts`,
  `${MAPPING}meeting-file-name.ts`,
  `${MAPPING}meeting-to-atlas.ts`,
  `${MAPPING}granola-note.ts`,
  './github-file.ts',
] as const;

/** Where the Slack capture mapper lives (#103), compiled for #104's Code node by the same rules. */
const CAPTURE_MAPPING = '../../packages/domain/src/capture/mapping/';

/**
 * The capture mapper's modules, in order: the meeting mapper's clock and
 * file-name rules it shares, then its own. A Slack message is written by the
 * same bytes whether n8n or the app maps it.
 */
const CAPTURE_MODULES = [
  `${MAPPING}meeting-mapping-error.ts`,
  `${MAPPING}meeting-instant.ts`,
  `${MAPPING}meeting-stated.ts`,
  `${MAPPING}meeting-when.ts`,
  `${MAPPING}meeting-file-name.ts`,
  `${CAPTURE_MAPPING}capture-refusal.ts`,
  `${CAPTURE_MAPPING}capture-text.ts`,
  `${CAPTURE_MAPPING}capture-emphasis.ts`,
  `${CAPTURE_MAPPING}capture-tree.ts`,
  `${CAPTURE_MAPPING}capture-linkify.ts`,
  `${CAPTURE_MAPPING}capture-mrkdwn.ts`,
  `${CAPTURE_MAPPING}capture-payload.ts`,
  `${CAPTURE_MAPPING}capture-to-atlas.ts`,
] as const;

const IMPORT = /^import\s[^;]*;[ \t]*\n?/gm;
const EXPORT = /^export\s+(?=(async\s+)?(function|class|const|let)\b)/gm;
const EMPTY_EXPORT = /^export\s*\{\s*\};?[ \t]*\n?/gm;

/** The names a module exports as values (types leave nothing behind in JavaScript). */
function exportedValues(source: ts.SourceFile): string[] {
  const exported = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((each) => each.kind === ts.SyntaxKind.ExportKeyword);
  return source.statements.filter(exported).flatMap((statement) => {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      return statement.name === undefined ? [] : [statement.name.text];
    }
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.map((each) => each.name.getText(source));
    }
    return [];
  });
}

/**
 * One module as a block of the script: its code in a scope of its own, so
 * its private names cannot meet another module's, handing out what it exports.
 */
export function moduleScript(name: string): string {
  const text = readFileSync(new URL(name, import.meta.url), 'utf8');
  const names = exportedValues(ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true));
  const { outputText } = ts.transpileModule(text, {
    fileName: name,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const code = outputText.replace(IMPORT, '').replace(EMPTY_EXPORT, '').replace(EXPORT, '');
  const list = names.join(', ');
  return `// ${name.slice(name.lastIndexOf('/') + 1)}\nconst { ${list} } = (() => {\n${code}return { ${list} };\n})();\n`;
}

const HEADER = [
  '// DFAI meeting mapper (meeting-import contract v1).',
  '// Generated from packages/domain/src/meetings/mapping/*.ts and tools/n8n/*.ts',
  '// in the DFAI repo by `pnpm n8n:build`:',
  '// change those files and rebuild rather than editing here.',
].join('\n');

/** The mapper as one plain-JavaScript script, followed by `run`, the node's own lines. */
export function codeNodeScript(run: string): string {
  return `${HEADER}\n\n${MODULES.map(moduleScript).join('\n')}\n// --- n8n ---\n${run}\n`;
}

const CAPTURE_HEADER = [
  '// DFAI capture mapper (capture contract v1).',
  '// Generated from packages/domain/src/capture/mapping/*.ts and the meeting mapper it shares',
  '// in the DFAI repo by `pnpm n8n:build`:',
  '// change those files and rebuild rather than editing here.',
].join('\n');

/** The capture mapper as one plain-JavaScript script, followed by `run`, the node's own lines. */
export function captureCodeNodeScript(run: string): string {
  const writer = readFileSync(new URL('capture-markdown.bundle.js', import.meta.url), 'utf8');
  const modules = CAPTURE_MODULES.map(moduleScript).join('\n');
  return `${CAPTURE_HEADER}\n\n${writer}\n${modules}\n// --- n8n ---\n${run}\n`;
}

/** A Slack capture's Code node (#104): the payload n8n assembles, as the file DFAI would write. */
export function mapCaptureScript(): string {
  return captureCodeNodeScript(
    [
      '// timeZone: the zone the times in the note are shown on.',
      // writeMarkdown: the app's own writer of a capture's tree, bundled above.
      `const OPTIONS = { timeZone: '${DEFAULT_TIME_ZONE}', writeMarkdown: dfaiCaptureMarkdown.writeCaptureMarkdown };`,
      'return { json: mapCapture($json, OPTIONS) };',
    ].join('\n'),
  );
}

/** The "Map meeting to DFAI file" node: run once for each item, one file per meeting. */
export const MAP_MEETING_NODE = 'Map meeting to DFAI file';

/** James's zone: an instant (`...Z`) is read on this clock unless OPTIONS says otherwise. */
export const DEFAULT_TIME_ZONE = 'America/Los_Angeles';

export function mapMeetingScript(): string {
  return codeNodeScript(
    [
      '// timeZone: the zone a date-time ending in Z or an offset (an instant) is read in.',
      '// A date or time without one is kept as written. null refuses instants.',
      '// groupAddresses: list addresses (e.g. "eng@example.com") that are groups but whose',
      '// local part does not say team/group/all/list/staff (joined by - or _).',
      `const OPTIONS = { timeZone: '${DEFAULT_TIME_ZONE}', groupAddresses: [] };`,
      'return { json: mapMeeting($json, OPTIONS) };',
    ].join('\n'),
  );
}

/** The "Same meeting?" node: is the file GitHub found at the path this meeting? */
export function sameMeetingScript(): string {
  return codeNodeScript(
    [
      `const meeting = $('${MAP_MEETING_NODE}').item.json;`,
      'const duplicate = sameMeeting(existingFileText($json), meeting);',
      'return { json: { ...meeting, duplicate } };',
    ].join('\n'),
  );
}

/** The "Same meeting at the other path?" node: passes this meeting on to the skip, or fails. */
export function sameMeetingAtOtherPathScript(): string {
  return codeNodeScript(
    [
      `const meeting = $('${MAP_MEETING_NODE}').item.json;`,
      'return { json: { ...meeting, duplicate: sameMeetingAtOtherPath($json, meeting) } };',
    ].join('\n'),
  );
}
