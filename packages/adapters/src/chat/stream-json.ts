import type { ModelUsage } from '@dfai/domain';
import { readApiUsage } from './api-usage.ts';

/**
 * Claude Code's `--output-format stream-json`, one JSON object per line,
 * translated into what the provider needs: words as they stream, and the
 * run's final verdict. Everything else it prints — the init line, rate-limit
 * notices, the whole assistant message repeated — is not needed and ignored.
 */
export type StreamJsonLine =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'result';
      readonly isError: boolean;
      readonly message: string;
      /** What the run spent, from its `usage` and `total_cost_usd`; null when they do not read. */
      readonly usage: ModelUsage | null;
    }
  | { readonly kind: 'other' };

const OTHER: StreamJsonLine = { kind: 'other' };

export function readStreamJsonLine(line: string): StreamJsonLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // A line that is not JSON is the program talking to a terminal; nothing
    // in it is part of the answer.
    return OTHER;
  }
  if (!isRecord(parsed)) return OTHER;
  if (parsed['type'] === 'stream_event') return streamEvent(parsed['event']);
  if (parsed['type'] === 'result') {
    const message = typeof parsed['result'] === 'string' ? parsed['result'] : '';
    const usage = readApiUsage(parsed['usage'], parsed['total_cost_usd']);
    return { kind: 'result', isError: parsed['is_error'] === true, message, usage };
  }
  return OTHER;
}

function streamEvent(event: unknown): StreamJsonLine {
  if (!isRecord(event) || event['type'] !== 'content_block_delta') return OTHER;
  const delta = event['delta'];
  if (!isRecord(delta) || delta['type'] !== 'text_delta' || typeof delta['text'] !== 'string') {
    return OTHER;
  }
  return { kind: 'text', text: delta['text'] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a failed run failed because Claude Code is not logged in. */
export function isLoginProblem(message: string): boolean {
  return /\/login|log ?in|invalid api key|not authenticated|oauth/i.test(message);
}
