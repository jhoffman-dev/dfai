import { readSkillDraft, skillDraftSystem, type ModelMessage, type SkillDraft } from '@dfai/domain';
import { ModelProviderError, type ModelProvider, type ProviderStatus } from '../chat/ports.ts';
import { runChatTurn } from '../chat/run-chat-turn.ts';
import type { ChatToolbox } from '../chat/toolbox.ts';

/** What asking Claude for a skill came to. Nothing is written in any case. */
export type SkillDraftOutcome =
  | {
      readonly kind: 'drafted';
      readonly draft: SkillDraft;
      /** The name Claude gave an existing skill, which was ignored; null when it kept the name. */
      readonly ignoredName: string | null;
    }
  /** Claude answered, but not with a skill the editor could take: why, in the domain's words. */
  | { readonly kind: 'refused'; readonly problems: readonly string[] }
  /** Claude cannot be reached: the provider's own words and fix, as the chat shows them. */
  | { readonly kind: 'unready'; readonly message: string; readonly fix: string | null }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'stopped' };

/** No tools: a draft is written from the skill and the request alone, and reads nothing. */
const NO_TOOLS: ChatToolbox = {
  specs: [],
  run: async (call) => ({
    result: {
      callId: call.id,
      name: call.name,
      content: 'There are no tools here.',
      isError: true,
    },
    proposal: null,
  }),
};

/** The text of the turn's last answer. */
function answerOf(added: readonly ModelMessage[]): string {
  const answers = added.filter((message) => message.role === 'assistant');
  return answers.at(-1)?.text ?? '';
}

/**
 * Asks Claude to draft a skill, or improve one (#169, ADR-0050): one turn,
 * with no tools, a fixed system prompt holding how to write a skill and its
 * rules, and the skill as it stands fenced as data. The answer is read and
 * checked by the domain; the caller shows it as a change to accept or not,
 * and only the editor's Save ever writes.
 */
export async function draftSkill({
  provider,
  model,
  current,
  fixedName,
  request,
  signal,
}: {
  provider: ModelProvider;
  model: string;
  /** The skill as the editor holds it; null when there is nothing yet. */
  current: SkillDraft | null;
  /** The name an existing skill keeps; null for a new skill. */
  fixedName: string | null;
  /** What the person asked for, in their words. */
  request: string;
  signal: AbortSignal;
}): Promise<SkillDraftOutcome> {
  // A status that cannot be asked is an unreachable Claude, as the chat panel says it.
  const status = await provider.status().catch((error: unknown): ProviderStatus => ({
    ready: false,
    problem: 'unavailable',
    message: String(error),
    fix: null,
  }));
  if (signal.aborted) return { kind: 'stopped' };
  if (!status.ready) return { kind: 'unready', message: status.message, fix: status.fix };
  try {
    const outcome = await runChatTurn({
      provider,
      toolbox: NO_TOOLS,
      model,
      system: skillDraftSystem({ current, fixedName }),
      history: [{ role: 'user', text: request }],
      signal,
      // Only the whole answer is read: a half-written JSON object is no draft.
      onEvent: () => {},
    });
    if (outcome.stopped || signal.aborted) return { kind: 'stopped' };
    const reading = readSkillDraft({ answer: answerOf(outcome.added), fixedName });
    return reading.ok
      ? { kind: 'drafted', draft: reading.draft, ignoredName: reading.ignoredName }
      : { kind: 'refused', problems: reading.problems };
  } catch (error) {
    if (signal.aborted) return { kind: 'stopped' };
    if (error instanceof ModelProviderError) return { kind: 'failed', message: error.message };
    throw error;
  }
}
