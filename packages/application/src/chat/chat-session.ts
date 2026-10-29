import {
  chatReport,
  chatSystemPrompt,
  skillCommandOf,
  usedSkillLine,
  type ChatContext,
  type ChatNoteEntry,
  type ChatNoteMessage,
  type ChatSkill,
  type ModelMessage,
  type ProfileState,
  type VaultPath,
} from '@dfai/domain';
import type { ActivityLog, ActivityRecorder } from '../activity/ports.ts';
import type { Clock } from '../ports.ts';
import type { SkillToUse } from '../skills/skill-to-use.ts';
import { VaultAccessError, type VaultFsPort } from '../vault/ports.ts';
import { readChat, recordChatEntries, type ChatRecord } from './chat-history.ts';
import { ModelProviderError, type ModelProvider, type ProviderProblem } from './ports.ts';
import type { AppliedProposal, Proposal } from './proposals.ts';
import { runChatTurn, type ChatTurnEvent } from './run-chat-turn.ts';
import { describeFailedToolCall, describeToolCall } from './tool-labels.ts';
import type { ChatToolbox } from './toolbox.ts';

/** One entry in the transcript, as the panel draws it. */
export type ChatItem =
  | { readonly kind: 'user'; readonly id: string; readonly text: string }
  | { readonly kind: 'assistant'; readonly id: string; readonly text: string }
  | {
      readonly kind: 'tool';
      readonly id: string;
      readonly label: string;
      readonly state: 'running' | 'done' | 'failed';
      /** Why it failed, when it did. */
      readonly detail: string | null;
    }
  | {
      readonly kind: 'proposal';
      readonly id: string;
      readonly proposal: Proposal;
      /** `accepting` while Accept's write is under way: nothing more may be asked of it. */
      readonly state: 'pending' | 'accepting' | 'accepted' | 'rejected' | 'undone';
      /** Why the last Accept or Undo was refused. */
      readonly problem: string | null;
    };

export interface ChatState {
  readonly items: readonly ChatItem[];
  readonly busy: boolean;
  readonly error: { readonly message: string; readonly problem: ProviderProblem | 'failed' } | null;
  /** What the chat was opened knowing; null once removed, or when there was nothing. */
  readonly context: ChatContext | null;
  /**
   * The skill the person attached (#169): asked with on every turn until
   * removed. Null when none is, after a new chat, and in a reopened one.
   */
  readonly skill: ChatSkillChip | null;
  /** The note this chat is kept in, once its first turn is written. */
  readonly chatPath: VaultPath | null;
  /** Why the chat's note could not be written, if it could not. */
  readonly notice: string | null;
}

/** The attached skill as its chip shows it: its name, and why it cannot be asked with, if it cannot. */
export interface ChatSkillChip {
  readonly name: string;
  readonly problem: string | null;
}

/** What a chat session is given. Read at the moment of use, so a vault switch or a setting change applies to the next question. */
export interface ChatSessionPorts {
  readonly provider: () => ModelProvider;
  readonly model: () => string;
  /**
   * Who the person is, from Settings → Profile: 'unknown' while it is not read
   * or cannot be. May wait briefly for a read under way, so a name about to
   * arrive is not sent as unknown.
   */
  readonly profile: () => Promise<ProfileState>;
  /** Null while no vault is open. */
  readonly toolbox: () => ChatToolbox | null;
  readonly clock: Clock;
  /** Where the chat's note is kept: the open vault, and the notes in it. Null while none is open. */
  readonly vault: () => { fs: VaultFsPort; notePaths: readonly VaultPath[] } | null;
  readonly accept: (proposal: Proposal) => Promise<AppliedProposal>;
  readonly undo: (applied: AppliedProposal) => Promise<void>;
  /** The skill `name` as it is now on disk, read when it is attached and again for each turn. */
  readonly skill: (name: string) => Promise<SkillToUse>;
  /** When the chat began, as the chat note writes it. */
  readonly stamp: () => string;
  readonly newId: () => string;
  /**
   * Where an Accept or Undo, and a turn or a chat note that failed, is said
   * (U-28) — never what was asked or answered.
   */
  readonly activity: ActivityLog;
}

export interface ChatSession {
  state(): ChatState;
  subscribe(listener: () => void): () => void;
  send(text: string): Promise<void>;
  stop(): void;
  /** Asks the last question again, in place of the answer (or failure) it got. */
  retry(): Promise<void>;
  /** The window's context, taken only before anything is asked. */
  offerContext(context: ChatContext | null): void;
  removeContext(): void;
  /** Attaches the skill `name` (#169): the person's choice, the only way a skill reaches the model. */
  attachSkill(name: string): Promise<void>;
  /** Takes the skill out: the next turn is asked without it. */
  removeSkill(): void;
  accept(id: string): Promise<void>;
  reject(id: string): void;
  undo(id: string): Promise<void>;
  newChat(): void;
  /**
   * Shows a past chat. Refused while an answer is arriving; dropped once read
   * if another chat was picked, a new one begun or a question asked meanwhile.
   */
  open(path: VaultPath): Promise<void>;
}

/** What one turn has shown so far: the answer, what was done, and each running call's item. */
interface Turn {
  readonly activity: string[];
  answer: string;
  /** The transcript item of each tool call, and its line in `activity`, by the call's id. */
  readonly tools: Map<string, { readonly item: string; readonly line: number }>;
}

const EMPTY: ChatState = {
  items: [],
  busy: false,
  error: null,
  context: null,
  skill: null,
  chatPath: null,
  notice: null,
};

/**
 * One conversation in the panel: what has been said, what is being said, and
 * what the model has proposed. It drives `runChatTurn`, keeps the chat's note,
 * and writes nothing to the vault except that note and what the person
 * accepts.
 */
export function createChatSession(ports: ChatSessionPorts): ChatSession {
  let state = EMPTY;
  let messages: ModelMessage[] = [];
  let contextRemoved = false;
  /**
   * Attaches and removals of a skill, and new or reopened chats: a skill read
   * that finishes after a later one is dropped.
   */
  let skillPicks = 0;
  let record: ChatRecord | null = null;
  let controller: AbortController | null = null;
  /**
   * The turn not yet asking the model: its Stop ends it at once. Once the
   * model is asked, a Stop ends the turn as the model's answer stops.
   */
  let waiting: AbortController | null = null;
  /**
   * Which conversation is showing. A new chat, a vault switch or an opened
   * chat moves it on, and a turn or an Accept begun under an older one drops
   * what it finishes with rather than touch this conversation or its note.
   */
  let generation = 0;
  /**
   * Picks of a past chat, and turns begun: a chat whose note is still being
   * read when another is picked, or a question is asked, is not shown once
   * read. The last thing the person did wins, and a question is never lost.
   */
  let picks = 0;
  let turnsBegun = 0;
  /** Whether the last question is already in the chat's note, so Retry writes only its new answer. */
  let questionKept = false;
  /** Accepts and rejects since the last question, told to the model with the next one. */
  let decisions: string[] = [];
  const applied = new Map<string, AppliedProposal>();
  const listeners = new Set<() => void>();

  const set = (next: Partial<ChatState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const setItem = (id: string, change: (item: ChatItem) => ChatItem) =>
    set({ items: state.items.map((item) => (item.id === id ? change(item) : item)) });

  /**
   * Asks the model `question`. A `/name` send hands over the turn it began —
   * its Stop — and the skill it just read and attached, so it is not read
   * twice; else the turn begins here and reads the chip's skill.
   */
  async function runTurn(
    question: string,
    { own = beginTurn(), read }: { own?: AbortController; read?: TurnSkill } = {},
  ): Promise<void> {
    const toolbox = ports.toolbox();
    const vault = ports.vault();
    // Taken before the turn waits: its lines belong to this vault, whatever opens meanwhile.
    const activity = ports.activity.inOpenVault();
    if (toolbox === null) {
      if (controller === own) controller = null;
      set({
        busy: false,
        error: { message: 'Open a vault to chat about it.', problem: 'unavailable' },
      });
      return;
    }
    const began = generation;
    const live = () => generation === began;
    set({ busy: true, error: null });
    const turn: Turn = { activity: [], answer: '', tools: new Map() };
    try {
      const profile = await ports.profile();
      // Stopped before the model was asked: nothing is asked, and nothing kept.
      if (!live() || own.signal.aborted) return;
      const skill = read ?? (await skillForTurn());
      if (!live() || own.signal.aborted) return;
      if (skill !== null && 'problem' in skill) {
        // Refused before Claude is asked: the question stays, to retry once the skill is put right.
        set({ busy: false, error: { message: skill.problem, problem: 'failed' } });
        return;
      }
      if (skill !== null) turn.activity.push(usedSkillLine(skill.name));
      if (waiting === own) waiting = null;
      const outcome = await runChatTurn({
        provider: ports.provider(),
        toolbox,
        model: ports.model(),
        system: chatSystemPrompt({
          today: ports.clock.today(),
          context: state.context,
          skill,
          profile,
        }),
        history: messages,
        signal: own.signal,
        onEvent: (event) => {
          if (live()) show(event, turn);
        },
      });
      if (!live()) return;
      messages = [...messages, ...outcome.added];
      set({ busy: false });
      if (vault !== null) await keep({ question, turn, vault, live, activity });
    } catch (error) {
      if (!live()) return;
      const problem = error instanceof ModelProviderError ? error.problem : 'failed';
      const message = error instanceof Error ? error.message : String(error);
      // Stopped by the person: nothing went wrong. The kind alone: a provider's words can quote the question.
      if (!own.signal.aborted) activity.record(chatReport({ kind: 'turnFailed', reason: problem }));
      set({ busy: false, error: { message, problem } });
    } finally {
      if (controller === own) controller = null;
      if (waiting === own) waiting = null;
    }
  }

  /**
   * The attached skill, read again for this turn so an edit since applies; null
   * when none is attached. One that cannot be asked with marks its chip.
   */
  async function skillForTurn(): Promise<TurnSkill> {
    const chip = state.skill;
    if (chip === null) return null;
    const pick = skillPicks;
    const found = await readSkillNamed(chip.name);
    // Taken off or changed while read: the turn asks with what the chip says now.
    if (pick !== skillPicks) return skillForTurn();
    set({ skill: chipOf(chip.name, found) });
    return turnSkillOf(chip.name, found);
  }

  async function readSkillNamed(name: string): Promise<SkillToUse> {
    try {
      return await ports.skill(name);
    } catch (error) {
      // Anything but the host's refusal is a bug, and goes on as one.
      if (!(error instanceof VaultAccessError)) throw error;
      // Not the host's words: they can name the Mac's folders. The chip says what DFAI knows.
      return { kind: 'unreadable' };
    }
  }

  /**
   * A turn begun: counted, so a past chat picked before it is not shown over
   * it, and given its Stop. Until the model is asked, Stop also ends the
   * wait at once — a read that never lands holds nothing.
   */
  function beginTurn(onStopped = () => {}): AbortController {
    turnsBegun += 1;
    const own = new AbortController();
    controller = own;
    waiting = own;
    own.signal.addEventListener('abort', () => {
      if (waiting !== own) return;
      waiting = null;
      onStopped();
      set({ busy: false });
    });
    return own;
  }

  /**
   * `/name question`: attaches the skill `name` and gives the question after
   * it ('' for none), with the skill as read when it was attached. A `/word`
   * that no skill can be shown to be — none is called that, or the skills
   * cannot be read — is the question itself, asked with the chip as it is.
   */
  async function takeSkillCommand(
    command: { name: string; rest: string },
    asked: string,
    signal: AbortSignal,
  ): Promise<{ question: string; read?: TurnSkill }> {
    const pick = (skillPicks += 1);
    const found = await readSkillNamed(command.name);
    if (found.kind === 'missing' || found.kind === 'unreadable') return { question: asked };
    // A chip taken off, another attached, or a new chat (which counts as a pick) since: dropped.
    if (pick !== skillPicks || signal.aborted) return { question: command.rest };
    set({ skill: chipOf(command.name, found) });
    return { question: command.rest, read: turnSkillOf(command.name, found) };
  }

  /** The question as the model and the transcript take it, in item `id` (a new one, or the one shown while its skill was read). */
  function ask(question: string, id: string): void {
    const told = decisions.length === 0 ? '' : `(${decisions.join(' ')})\n\n`;
    decisions = [];
    messages = [...messages, { role: 'user', text: told + question }];
    questionKept = false;
    const item: ChatItem = { kind: 'user', id, text: question };
    const shown = state.items.some((each) => each.id === id);
    set({
      items: shown
        ? state.items.map((each) => (each.id === id ? item : each))
        : [...state.items, item],
    });
  }

  /**
   * `/name question`. Shown as typed at once, and busy until asked, so nothing
   * sent meanwhile overtakes it and a past chat picked meanwhile is refused.
   * New chat meanwhile leaves it with the chat it was asked in, as New chat
   * leaves any question still being answered.
   */
  async function sendWithSkill(command: { name: string; rest: string }, asked: string) {
    const id = ports.newId();
    const began = generation;
    // Stopped while its skill is read: shown as typed, as a stopped question stays, and never asked.
    const own = beginTurn(() => ask(asked, id));
    set({ busy: true, error: null, items: [...state.items, { kind: 'user', id, text: asked }] });
    const done = () => {
      if (controller === own) controller = null;
      if (waiting === own) waiting = null;
    };
    let taken: Awaited<ReturnType<typeof takeSkillCommand>>;
    try {
      taken = await takeSkillCommand(command, asked, own.signal);
    } catch (error) {
      done();
      if (generation !== began || own.signal.aborted) return;
      // A bug, said as the turn's failure: the question stays, to retry as typed.
      ask(asked, id);
      set({ busy: false, error: { message: messageOf(error), problem: 'failed' } });
      return;
    }
    if (generation !== began) return;
    if (own.signal.aborted) {
      done();
      return;
    }
    const { question, read } = taken;
    if (question === '') {
      done();
      set({ busy: false, items: state.items.filter((item) => item.id !== id) });
      return;
    }
    ask(question, id);
    await runTurn(question, { own, ...(read !== undefined && { read }) });
  }

  /** A past chat, read from its note, as the conversation now showing. */
  function showChat(path: VaultPath, read: readonly ChatNoteMessage[]): void {
    generation += 1;
    questionKept = true;
    messages = read.map((message) =>
      message.role === 'user'
        ? { role: 'user', text: message.text }
        : { role: 'assistant', text: message.text, toolCalls: [] },
    );
    decisions = [];
    record = { path };
    contextRemoved = true;
    // A skill is not kept with a chat: a reopened one is asked without, until one is attached again.
    skillPicks += 1;
    applied.clear();
    set({
      ...EMPTY,
      chatPath: path,
      items: read.map((message) => ({ kind: message.role, id: ports.newId(), text: message.text })),
    });
  }

  function show(event: ChatTurnEvent, turn: Turn): void {
    if (event.type === 'text') {
      const last = state.items.at(-1);
      if (last?.kind === 'assistant') {
        turn.answer += event.text;
        setItem(last.id, () => ({ ...last, text: last.text + event.text }));
      } else {
        // A new paragraph of the answer, after the tools it waited on.
        turn.answer += turn.answer === '' ? event.text : `\n\n${event.text}`;
        set({
          items: [...state.items, { kind: 'assistant', id: ports.newId(), text: event.text }],
        });
      }
      return;
    }
    if (event.type === 'tool_started') {
      const label = describeToolCall(event.call);
      const id = ports.newId();
      turn.tools.set(event.call.id, { item: id, line: turn.activity.push(label) - 1 });
      const item: ChatItem = { kind: 'tool', id, label, state: 'running', detail: null };
      set({ items: [...state.items, item] });
      return;
    }
    finishTool(event, turn);
    if (event.proposal !== null) {
      const item: ChatItem = {
        kind: 'proposal',
        id: event.proposal.id,
        proposal: event.proposal,
        state: 'pending',
        problem: null,
      };
      set({ items: [...state.items, item] });
    }
  }

  /** Marks a call's item done or failed; a failed one says so, and why, in the chat's note too. */
  function finishTool(event: Extract<ChatTurnEvent, { type: 'tool_finished' }>, turn: Turn) {
    const shown = turn.tools.get(event.call.id);
    if (shown === undefined) return;
    const { isError, content } = event.result;
    const label = isError ? describeFailedToolCall(event.call) : null;
    if (label !== null) turn.activity[shown.line] = `${label}: ${content}`;
    setItem(shown.item, (item) =>
      item.kind === 'tool'
        ? {
            ...item,
            label: label ?? item.label,
            state: isError ? 'failed' : 'done',
            detail: isError ? content : null,
          }
        : item,
    );
  }

  /**
   * Writes the turn to the chat's note, in the vault the turn was asked in. A
   * failure is shown, and the chat goes on.
   */
  async function keep({
    question,
    turn,
    vault,
    live,
    activity,
  }: {
    question: string;
    turn: Turn;
    vault: { fs: VaultFsPort; notePaths: readonly VaultPath[] };
    live: () => boolean;
    activity: ActivityRecorder;
  }) {
    const answer: ChatNoteEntry = { role: 'assistant', text: turn.answer, activity: turn.activity };
    const entries: ChatNoteEntry[] = questionKept
      ? [answer]
      : [{ role: 'user', text: question }, answer];
    try {
      const kept = await recordChatEntries({
        fs: vault.fs,
        record,
        header: {
          created: ports.stamp(),
          model: ports.model(),
          context: state.context?.title ?? null,
          firstMessage: question,
        },
        entries,
        notePaths: vault.notePaths,
      });
      if (!live()) return;
      record = kept;
      questionKept = true;
      set({ chatPath: kept.path, notice: null });
    } catch (error) {
      if (!live()) return;
      const problem = messageOf(error);
      // A fixed line: the error's words can name the chat note, and its name is the question.
      activity.record(chatReport({ kind: 'notKept' }));
      set({ notice: `The chat could not be saved to Chats/: ${problem}` });
    }
  }

  function lastQuestion(): { at: number; text: string } | null {
    for (let at = state.items.length - 1; at >= 0; at -= 1) {
      const item = state.items[at];
      if (item?.kind === 'user') return { at, text: item.text };
    }
    return null;
  }

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(text) {
      const asked = text.trim();
      if (asked === '' || state.busy) return;
      const command = skillCommandOf(asked);
      if (command !== null) return sendWithSkill(command, asked);
      ask(asked, ports.newId());
      await runTurn(asked);
    },
    stop() {
      controller?.abort();
    },
    async retry() {
      const asked = lastQuestion();
      if (asked === null || state.busy) return;
      const at = messages.findLastIndex((message) => message.role === 'user');
      messages = messages.slice(0, at + 1);
      set({ items: state.items.slice(0, asked.at + 1), error: null });
      await runTurn(asked.text);
    },
    offerContext(context) {
      if (messages.length > 0 || contextRemoved) return;
      set({ context });
    },
    removeContext() {
      contextRemoved = true;
      set({ context: null });
    },
    async attachSkill(name) {
      const pick = (skillPicks += 1);
      set({ skill: { name, problem: null } });
      const found = await readSkillNamed(name);
      // A new chat or a reopened one counts as a pick, so this drops a read they came after too.
      if (pick === skillPicks) set({ skill: chipOf(name, found) });
    },
    removeSkill() {
      skillPicks += 1;
      set({ skill: null });
    },
    async accept(id) {
      const item = state.items.find((candidate) => candidate.id === id);
      if (item?.kind !== 'proposal' || item.state !== 'pending') return;
      const began = generation;
      // Marked before the write, so a second click finds it no longer pending.
      setItem(id, (current) => ({ ...current, state: 'accepting' }) as ChatItem);
      try {
        const done = await ports.accept(item.proposal);
        // A chat left behind — a new one, another vault — is not this log's to speak for.
        if (generation !== began) return;
        ports.activity.record(
          chatReport({ kind: 'accepted', path: done.path, created: done.kind === 'created' }),
        );
        applied.set(id, done);
        decisions.push(`The person accepted: ${describeProposal(item.proposal)}.`);
        setItem(id, (current) => ({ ...current, state: 'accepted', problem: null }) as ChatItem);
      } catch (error) {
        if (generation !== began) return;
        const problem = messageOf(error);
        const path = item.proposal.path;
        ports.activity.record(chatReport({ kind: 'refused', doing: 'accept', path, problem }));
        setItem(id, (current) => ({ ...current, state: 'pending', problem }) as ChatItem);
      }
    },
    reject(id) {
      const item = state.items.find((candidate) => candidate.id === id);
      if (item?.kind !== 'proposal' || item.state !== 'pending') return;
      decisions.push(`The person rejected: ${describeProposal(item.proposal)}.`);
      setItem(id, (current) => ({ ...current, state: 'rejected', problem: null }) as ChatItem);
    },
    async undo(id) {
      const done = applied.get(id);
      if (done === undefined) return;
      const began = generation;
      // Taken before the write, so a second click has nothing to undo.
      applied.delete(id);
      try {
        await ports.undo(done);
        if (generation !== began) return;
        ports.activity.record(chatReport({ kind: 'undone', path: done.path }));
        decisions.push(`The person undid the change they had accepted to ${done.path}.`);
        setItem(id, (current) => ({ ...current, state: 'undone', problem: null }) as ChatItem);
      } catch (error) {
        if (generation !== began) return;
        const problem = messageOf(error);
        ports.activity.record(
          chatReport({ kind: 'refused', doing: 'undo', path: done.path, problem }),
        );
        applied.set(id, done);
        setItem(id, (current) => ({ ...current, problem }) as ChatItem);
      }
    },
    newChat() {
      generation += 1;
      controller?.abort();
      controller = null;
      questionKept = false;
      messages = [];
      decisions = [];
      record = null;
      contextRemoved = false;
      skillPicks += 1;
      applied.clear();
      set(EMPTY);
    },
    async open(path) {
      const vault = ports.vault();
      if (vault === null) return;
      // Refused, never ignored: the caller says why (Past chats is disabled meanwhile).
      if (state.busy) throw new Error(OPEN_WHILE_BUSY);
      const pick = (picks += 1);
      const began = generation;
      const asked = turnsBegun;
      const current = () => pick === picks && began === generation && asked === turnsBegun;
      let read: ChatNoteMessage[];
      try {
        read = await readChat({ fs: vault.fs, path });
      } catch (error) {
        // A pick the person has moved on from fails unsaid: nobody is waiting on it.
        if (current()) throw error;
        return;
      }
      if (current()) showChat(path, read);
    },
  };
}

/** Why a past chat is not opened while an answer is still arriving. */
const OPEN_WHILE_BUSY = 'Wait for the answer to finish before opening another chat.';

/** A turn's skill: the one to ask with, why it cannot be, or none. */
type TurnSkill = ChatSkill | { problem: string } | null;

function turnSkillOf(name: string, found: SkillToUse): TurnSkill {
  return found.kind === 'usable'
    ? { name: found.name, instructions: found.instructions }
    : { problem: skillProblem(name, found) };
}

/** The chip of the skill `name` as it was just read. */
function chipOf(name: string, found: SkillToUse): ChatSkillChip {
  return found.kind === 'usable'
    ? { name: found.name, problem: null }
    : { name, problem: skillProblem(name, found) };
}

/** Why the skill `name` is not asked with, as its chip and the refused turn say it. */
function skillProblem(name: string, found: Exclude<SkillToUse, { kind: 'usable' }>): string {
  switch (found.kind) {
    case 'unreadable':
      return `The skill ${name} could not be read.`;
    case 'missing':
      return `The skill ${name} is not in .atlas/skills.`;
    case 'unusable':
      return `The skill ${name} cannot be used: ${found.message}`;
  }
}

function describeProposal(proposal: Proposal): string {
  return proposal.kind === 'edit'
    ? `the proposed edit to ${proposal.path}`
    : `the proposed new note “${proposal.title}”`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
