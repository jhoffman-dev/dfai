/*
 * How a rule's log says the tokens a Claude step spent (#788), summed over
 * its asks: everything the model read, how much of that came from the prompt
 * cache and went into it, and what it wrote — and the cost, when the provider
 * said one:
 *
 * - usage in `41200` (cached `30100`, written `2100`) out `2140` cost `0.41` USD
 */

import { inputTokens, type ModelUsage } from '../chat/model-usage.ts';
import { code, JSON_SPAN } from './log-spans.ts';

const USAGE_LINE = new RegExp(
  `^- usage in ${JSON_SPAN} \\(cached ${JSON_SPAN}, written ${JSON_SPAN}\\) out ${JSON_SPAN}` +
    `(?: cost ${JSON_SPAN} USD)?$`,
);

export function usageLine(usage: ModelUsage): string {
  const cost = usage.costUsd === undefined ? '' : ` cost ${code(usage.costUsd)} USD`;
  return `- usage in ${code(inputTokens(usage))} (cached ${code(usage.cacheRead)}, written ${code(usage.cacheCreation)}) out ${code(usage.output)}${cost}`;
}

/** The usage the first usage line says; null when there is none, or it does not read. */
export function usageOf(body: readonly string[]): ModelUsage | null {
  for (const line of body) {
    const match = USAGE_LINE.exec(line);
    if (match === null) continue;
    try {
      return usageFrom(
        match
          .slice(1)
          .map((span) => (span === undefined ? undefined : (JSON.parse(span) as unknown))),
      );
    } catch {
      // A line edited into JSON that does not read is left out, as any other line is.
      return null;
    }
  }
  return null;
}

function usageFrom([total, cacheRead, cacheCreation, output, cost]: unknown[]): ModelUsage | null {
  if (!isCount(total) || !isCount(cacheRead) || !isCount(cacheCreation) || !isCount(output)) {
    return null;
  }
  const input = total - cacheRead - cacheCreation;
  if (input < 0) return null;
  if (cost !== undefined && !(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)) {
    return null;
  }
  return { input, cacheCreation, cacheRead, output, ...(cost !== undefined && { costUsd: cost }) };
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;
