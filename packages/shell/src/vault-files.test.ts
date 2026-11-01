/**
 * DFAI's own vault, checked by DFAI's own parsers.
 *
 * The views, dashboards and sources in `vault/.atlas` are what this project
 * uses to run itself, and they are hand-edited markdown. A mistyped key does
 * not fail a build — the parsers are deliberately forgiving, so a broken widget
 * is dropped and a layout that has lost the property it needs quietly falls
 * back to a table. That is right in someone's vault and wrong in ours, where it
 * means a file we ship no longer does what it says.
 *
 * Paths are relative to the repository root, which is where vitest runs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { remarkMarkdown } from '@dfai/adapters';
import {
  compileAtlasQuery,
  isDashboard,
  isSavedView,
  parseAtlasQuery,
  parseDashboard,
  parseObjectType,
  parseQueryView,
  parseSavedView,
  parseViewDisplay,
  isDatasource,
  parseDatasource,
  splitFrontmatter,
} from '@dfai/domain';

/** Read the way the app reads it: the same split and the same parser. */
const frontmatterOf = (path: string): Record<string, unknown> => {
  const document = splitFrontmatter(readFileSync(path, 'utf8'));
  return remarkMarkdown.frontmatterProperties(document.frontmatter);
};

const filesIn = (dir: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith('.md'))
      .map((n) => `${dir}/${n}`);
  } catch {
    return [];
  }
};

/** Why a DFAI query view's text does not read against this vault's types, or null. */
function atlasQueryProblem(text: string): string | null {
  const types = filesIn('vault/.atlas/types').map((path) => parseObjectType(frontmatterOf(path)));
  try {
    compileAtlasQuery(parseAtlasQuery(text), { types, resolveLink: () => null });
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

describe("DFAI's own vault", () => {
  /**
   * Everything below asks "is anything here broken?", which an empty list
   * answers just as well as a healthy one. This is the test that makes the
   * others mean something.
   */
  it('is where this test thinks it is', () => {
    expect(filesIn('vault/.atlas/views').length).toBeGreaterThan(0);
    expect(filesIn('vault/.atlas/dashboards').length).toBeGreaterThan(0);
    expect(filesIn('vault/.atlas/sources').length).toBeGreaterThan(0);
  });
  it('has views that all parse', () => {
    const broken: string[] = [];
    for (const path of filesIn('vault/.atlas/views')) {
      const fm = frontmatterOf(path);
      if (!isSavedView(fm)) {
        broken.push(`${path}: not marked atlas: view`);
        continue;
      }
      if (parseSavedView(fm) !== null) continue;
      const query = parseQueryView(fm);
      if (query === null) {
        broken.push(`${path}: does not parse`);
        continue;
      }
      const problem = atlasQueryProblem(query);
      if (problem !== null) broken.push(`${path}: ${problem}`);
    }
    expect(broken).toEqual([]);
  });

  it('has views whose layout has what it needs', () => {
    const broken: string[] = [];
    for (const path of filesIn('vault/.atlas/views')) {
      const fm = frontmatterOf(path);
      const declared = String(fm['layout'] ?? 'table');
      const display = parseViewDisplay(fm);
      // parseViewDisplay silently falls back to a table when a layout is
      // missing the property it needs. That is right at runtime and wrong in
      // our own vault, where it means the view does not do what it says.
      if (declared !== 'table' && display.layout !== declared) {
        broken.push(`${path}: says ${declared}, falls back to ${display.layout}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('has dashboards whose every widget parses', () => {
    const broken: string[] = [];
    for (const path of filesIn('vault/.atlas/dashboards')) {
      const fm = frontmatterOf(path);
      if (!isDashboard(fm)) {
        broken.push(`${path}: not marked atlas: dashboard`);
        continue;
      }
      const declared = Array.isArray(fm['widgets']) ? fm['widgets'].length : 0;
      const parsed = parseDashboard(fm).length;
      if (parsed !== declared)
        broken.push(`${path}: ${declared} widgets declared, ${parsed} parse`);
    }
    expect(broken).toEqual([]);
  });

  it('has sources that all parse', () => {
    const broken: string[] = [];
    for (const path of filesIn('vault/.atlas/sources')) {
      const fm = frontmatterOf(path);
      if (!isDatasource(fm)) {
        broken.push(`${path}: not marked atlas: source`);
        continue;
      }
      if (parseDatasource(fm) === null) broken.push(`${path}: does not parse`);
    }
    expect(broken).toEqual([]);
  });

  /**
   * A template is copied as it is, so its body is what every new note starts
   * with: a few lines to fill in, never documentation. The Dashboard template
   * once carried its whole reference table into each new dashboard.
   */
  it('has templates whose body is only what a new note starts with', () => {
    const templates = filesIn('vault/.atlas/templates');
    expect(templates.length).toBeGreaterThan(0);
    const wordy: string[] = [];
    for (const path of templates) {
      const { body } = splitFrontmatter(readFileSync(path, 'utf8'));
      const lines = body.split('\n').filter((line) => line.trim() !== '');
      if (lines.length > MAX_TEMPLATE_LINES) wordy.push(`${path}: ${lines.length} lines`);
    }
    expect(wordy).toEqual([]);
  });
});

/** Daily's two headings and a line under each is about as much as a template needs. */
const MAX_TEMPLATE_LINES = 4;
