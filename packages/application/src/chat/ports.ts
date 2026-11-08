import type { ModelMessage, ModelToolSpec, ModelUsage, ToolCall } from '@dfai/domain';

/** Everything one model turn is sent: who it is, what was said, what it may call. */
export interface ModelRequest {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolSpec[];
}

/** What a model sends back, as it arrives. */
export type ModelEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_call'; readonly call: ToolCall }
  /** A tool call written so badly it could not be read; the model is told why. */
  | { readonly type: 'malformed'; readonly problem: string }
  /**
   * What the call spent, once it is known (#788); a provider that reports
   * none, or none that reads, sends no such event, and the call's usage is
   * unknown.
   */
  | { readonly type: 'usage'; readonly usage: ModelUsage };

/** Why a provider cannot be used right now. */
export type ProviderProblem = 'not_installed' | 'not_logged_in' | 'no_key' | 'unavailable';

export type ProviderStatus =
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly problem: ProviderProblem;
      /** What is wrong, in a sentence. */
      readonly message: string;
      /** A command or a step that fixes it, shown so it can be copied; null when there is none. */
      readonly fix: string | null;
    };

export type ChatProviderId = 'claude-code' | 'anthropic-api';

/**
 * A model DFAI can talk to (ADR-0021). Claude Code and the Anthropic API are
 * the two there are; a local model behind an OpenAI-compatible endpoint would
 * be a third, and nothing above the adapters would change.
 */
export interface ModelProvider {
  readonly id: ChatProviderId;
  /** Whether it can answer now, and what to do when it cannot. */
  status(): Promise<ProviderStatus>;
  /**
   * One model turn. Ends when the model stops; rejects with
   * `ModelProviderError` on a failure, and with `ChatCancelled` once `signal`
   * is aborted.
   */
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

/** A provider's refusal or failure, said in words the person can act on. */
export class ModelProviderError extends Error {
  readonly problem: ProviderProblem | 'failed';
  constructor(problem: ProviderProblem | 'failed', message: string) {
    super(message);
    this.name = 'ModelProviderError';
    this.problem = problem;
  }
}

/** The person pressed Stop. */
export class ChatCancelled extends Error {
  constructor() {
    super('Stopped.');
    this.name = 'ChatCancelled';
  }
}
