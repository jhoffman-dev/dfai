import type { ModelUsage } from '@dfai/domain';

/**
 * The Anthropic API's `usage` object — which Claude Code's result line
 * repeats — as a `ModelUsage`; null when it does not read (#788). The input
 * and output counts must be there: a call whose usage is missing is unknown,
 * never free. The cache counts may be null or absent, which the API says when
 * no cache was used. A cost that does not read is left out; the counts stand.
 */
export function readApiUsage(raw: unknown, costUsd?: unknown): ModelUsage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const input = fields['input_tokens'];
  const output = fields['output_tokens'];
  const cacheCreation = cacheCount(fields['cache_creation_input_tokens']);
  const cacheRead = cacheCount(fields['cache_read_input_tokens']);
  if (!isCount(input) || !isCount(output) || cacheCreation === null || cacheRead === null) {
    return null;
  }
  const cost = isCost(costUsd) ? { costUsd } : {};
  return { input, cacheCreation, cacheRead, output, ...cost };
}

/** A count DFAI can add and log exactly: one past the safe integers is unknown. */
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isCost = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** A cache count, none when the API leaves it out; null when it says one that does not read. */
function cacheCount(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  return isCount(value) ? value : null;
}
