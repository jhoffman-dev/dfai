/**
 * The tokens one call to the model spent (#788), as its provider reported
 * them. `input` is only what was read fresh: what was written to the prompt
 * cache and what was read back from it are counted apart, as Anthropic counts
 * them, so `inputTokens` adds the three for everything the model read.
 *
 * Usage nobody reported — a provider that said none, or said it in a shape
 * that does not read — is `null`: unknown, never zero.
 */
export interface ModelUsage {
  readonly input: number;
  readonly cacheCreation: number;
  readonly cacheRead: number;
  readonly output: number;
  /** What the provider says it cost, in US dollars; left out when it says nothing. */
  readonly costUsd?: number;
}

export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    input: a.input + b.input,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
    ...(a.costUsd !== undefined && b.costUsd !== undefined && { costUsd: a.costUsd + b.costUsd }),
  };
}

/**
 * Every reading added up; unknown when there are none, or when one of them is
 * unknown — a total that left a call out would say too little.
 */
export function sumUsage(readings: readonly (ModelUsage | null)[]): ModelUsage | null {
  let total: ModelUsage | null = null;
  for (const reading of readings) {
    if (reading === null) return null;
    total = total === null ? reading : addUsage(total, reading);
  }
  return total;
}

/** Every token the model read: fresh, written to the cache, and read from it. */
export function inputTokens(usage: ModelUsage): number {
  return usage.input + usage.cacheCreation + usage.cacheRead;
}

/** A count of tokens as a line says it: `980`, `2.1k`, `41k`, `1.3M`. */
export function shortTokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  return Math.round(count / 1000) < 1000 ? scaled(count, 1000, 'k') : scaled(count, 1e6, 'M');
}

/** One decimal below ten of the unit, whole numbers from there. */
function scaled(count: number, unit: number, suffix: string): string {
  const tenths = Math.round(count / (unit / 10)) / 10;
  return tenths < 10 ? `${tenths}${suffix}` : `${Math.round(count / unit)}${suffix}`;
}

/** Usage as a line says it: `41k in (30k cached), 2.1k out`, or `usage unknown`. */
export function usageWords(usage: ModelUsage | null): string {
  if (usage === null) return 'usage unknown';
  const cached = usage.cacheRead === 0 ? '' : ` (${shortTokens(usage.cacheRead)} cached)`;
  return `${shortTokens(inputTokens(usage))} in${cached}, ${shortTokens(usage.output)} out`;
}
