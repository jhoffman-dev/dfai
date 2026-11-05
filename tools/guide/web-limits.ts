/*
 * The guide's list of what DFAI on the web cannot do, written into its
 * section as the guide is built (#670): drawn from the capability map through
 * the same table Settings → Not available here reads, so neither is kept by
 * hand and the two cannot say different things.
 */
import type { PlatformLimit } from '../../packages/application/src/platform/index.ts';
import type { GuideSources } from './assemble.ts';

/** The line in a section file the list's items take the place of. */
export const WEB_LIMITS_MARKER = '<!-- guide:web-limits -->';

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const escaped = (text: string) => text.replace(/[&<>]/g, (char) => ESCAPES[char] ?? char);

/** The list's items, one line each, at the marker's own indent. */
function items(indent: string, limits: readonly PlatformLimit[]): string {
  return limits
    .map((limit) => `${indent}<li><b>${escaped(limit.what)}.</b> ${escaped(limit.why)}</li>`)
    .join('\n');
}

const isMarker = (line: string) => line.trim() === WEB_LIMITS_MARKER;

/**
 * The sources with the marker line filled in. It must be in one section,
 * once: a second would publish the list twice, and none would mean the
 * section lost its list without a word.
 */
export function withWebLimits(
  sources: GuideSources,
  limits: readonly PlatformLimit[],
): GuideSources {
  const holding = [...sources.sections].filter(([, text]) => text.split('\n').some(isMarker));
  const [only, ...more] = holding;
  if (only === undefined || more.length > 0) {
    throw new Error(
      `the guide must hold ${WEB_LIMITS_MARKER} in one section, not ${holding.length}`,
    );
  }
  const [id, text] = only;
  const lines = text.split('\n');
  if (lines.filter(isMarker).length !== 1) {
    throw new Error(`guide section ${id}: ${WEB_LIMITS_MARKER} is there more than once`);
  }
  const filled = lines
    .map((line) => (isMarker(line) ? items(/^\s*/.exec(line)?.[0] ?? '', limits) : line))
    .join('\n');
  return { page: sources.page, sections: new Map([...sources.sections, [id, filled]]) };
}
