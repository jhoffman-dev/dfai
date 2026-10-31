import { describe, expect, it } from 'vitest';
import { createVaultPath, EMPTY_PROFILE, type VaultPath } from '@dfai/domain';
import type { SkillToUse } from '../skills/skill-to-use.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { apiFixture, TODAY } from '../testing/api-fixture.ts';
import { blockMarkdown } from '../testing/block-markdown.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeModel, type ScriptedRound } from '../testing/fake-model.ts';
import { createChatSession, type ChatItem } from './chat-session.ts';
import { acceptProposal, undoProposal } from './proposals.ts';
import { createChatToolbox } from './toolbox.ts';

/**
 * PR #635 attack: the chat's skill, with the skill port, a past chat's read
 * and the model each held open by hand, so the order things land in is the
 * test's to choose.
 */

const PAST: VaultPath = createVaultPath('Chats/Quill rollout.md');
const chatNote = (question: string, answer: string) =>
  `---\ntype: chat\n---\n\n## You\n\n${question}\n\n## Claude\n\n${answer}\n`;
const REVIEW: SkillToUse = { kind: 'usable', name: 'weekly-review', instructions: 'Review.' };
const OTHER: SkillToUse = { kind: 'usable', name: 'standup', instructions: 'Stand up.' };

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

/** Reads answered by hand, in the order they were made. */
function heldSkills() {
  const waiting: { name: string; resolve: (found: SkillToUse) => void }[] = [];
  return {
    port: (name: string) =>
      new Promise<SkillToUse>((resolve) => {
        waiting.push({ name, resolve });
      }),
    /** Answers the oldest read with what the vault holds for its name. */
    answerNext: (vault: Record<string, SkillToUse>) => {
      const read = waiting.shift();
      if (read === undefined) return false;
      read.resolve(vault[read.name] ?? { kind: 'missing' });
      return true;
    },
    pending: () => waiting.length,
  };
}

function session({
  rounds,
  skill,
  pastRead = Promise.resolve(),
}: {
  rounds: ScriptedRound[];
  skill: (name: string) => Promise<SkillToUse>;
  pastRead?: Promise<void>;
}) {
  const fixture = apiFixture({
    files: { 'Plan.md': 'Intro.\n', [PAST]: chatNote('Quill rollout', 'Tobias owns it.') },
    markdown: blockMarkdown(),
  });
  const fs: VaultFsPort = {
    ...fixture.fs,
    readTextFile: async (path) => {
      if (path === PAST) await pastRead;
      return fixture.fs.readTextFile(path);
    },
  };
  const markdown = blockMarkdown();
  const model = fakeModel(rounds);
  let ids = 0;
  const newId = () => `id-${(ids += 1)}`;
  const openNotes = { state: () => 'closed' as const, reload: () => {} };
  const chat = createChatSession({
    provider: () => model,
    model: () => 'claude-opus-5-5',
    profile: () => Promise.resolve(EMPTY_PROFILE),
    toolbox: () => createChatToolbox({ api: fixture.deps, fs, markdown, newId }),
    clock: { today: () => TODAY, now: () => 0, localNow: () => `${TODAY}T09:00:00` },
    vault: () => ({ fs, notePaths: [...fixture.files.keys()].map(createVaultPath) }),
    accept: (proposal) => acceptProposal({ fs, openNotes, proposal }),
    undo: (applied) => undoProposal({ fs, openNotes, applied }),
    skill,
    stamp: () => '2026-09-22 09:00',
    newId,
    activity: recordingActivity(),
  });
  return { chat, model, fixture };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const userTexts = (items: readonly ChatItem[]) =>
  items.flatMap((item) => (item.kind === 'user' ? [item.text] : []));

describe('a /name question and a past chat still being read (PR #635 attack)', () => {
  it('is not lost when the past chat picked before it finishes reading during its skill read', async () => {
    const past = gate();
    const held = heldSkills();
    const { chat, model } = session({
      rounds: [[{ type: 'text', text: 'Reviewed.' }]],
      skill: held.port,
      pastRead: past.opened,
    });
    // Past chats picked first; the person types a /name question before its note is read.
    const opening = chat.open(PAST);
    const asking = chat.send('/weekly-review What did I finish?');
    await settle();
    past.open();
    await opening;
    held.answerNext({ 'weekly-review': REVIEW });
    held.answerNext({ 'weekly-review': REVIEW });
    await asking;

    // A plain question asked in that window wins over the pick (open-race tests); a /name one must too.
    expect(userTexts(chat.state().items)).toContain('What did I finish?');
    expect(model.requests).toHaveLength(1);
  });
});

describe('Stop while a /name question’s skill is read (PR #635 attack)', () => {
  it('stops it: the question is not asked once the read lands', async () => {
    const held = heldSkills();
    const { chat } = session({
      rounds: [[{ type: 'text', text: 'Should never be asked.' }]],
      skill: held.port,
    });
    const asking = chat.send('/weekly-review What did I finish?');
    expect(chat.state().busy).toBe(true);
    // The composer shows Stop while busy; the person presses it.
    chat.stop();
    held.answerNext({ 'weekly-review': REVIEW });
    await settle();
    held.answerNext({ 'weekly-review': REVIEW });
    await asking;

    // Claude was asked anyway, under a fresh signal the Stop never reached.
    expect(chat.state().items.filter((item) => item.kind === 'assistant')).toEqual([]);
    expect(chat.state().busy).toBe(false);
  });

  it('keeps no “Used the skill” answer for a turn stopped while its skill was re-read', async () => {
    const held = heldSkills();
    const { chat, fixture } = session({
      rounds: [[{ type: 'text', text: 'Should never be asked.' }]],
      skill: held.port,
    });
    const attaching = chat.attachSkill('weekly-review');
    held.answerNext({ 'weekly-review': REVIEW });
    await attaching;
    const asking = chat.send('What did I finish?');
    await settle();
    expect(held.pending()).toBe(1);
    chat.stop();
    held.answerNext({ 'weekly-review': REVIEW });
    await asking;

    const kept = [...fixture.files.values()].map((file) => file.text).join('\n');
    // Nothing was asked of Claude, so nothing was answered with the skill.
    expect(kept).not.toContain('Used the skill weekly-review');
  });

  it('releases busy at once, even while the skill read never lands', async () => {
    const held = heldSkills();
    const { chat } = session({ rounds: [], skill: held.port });
    void chat.send('/weekly-review What did I finish?');
    chat.stop();
    await settle();
    expect(chat.state().busy).toBe(false);
  });
});

/**
 * Seeded runs of what a person can do, with every skill read and model reply
 * held until the run lets it land. The invariants are checked at each model
 * request and once everything has settled.
 */
describe('the chat skill session over seeded sequences (PR #635 attack)', () => {
  function seeded(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const VAULT: Record<string, SkillToUse> = { 'weekly-review': REVIEW, standup: OTHER };
  type Step =
    | 'attach-review'
    | 'attach-standup'
    | 'remove'
    | 'send'
    | 'send-skill'
    | 'answer-read'
    | 'stop'
    | 'new-chat';
  const STEPS: Step[] = [
    'attach-review',
    'attach-standup',
    'remove',
    'send',
    'send',
    'send-skill',
    'send-skill',
    'answer-read',
    'answer-read',
    'answer-read',
    'stop',
    'new-chat',
  ];

  async function run(seed: number, steps: readonly Step[]) {
    const random = seeded(seed);
    const held = heldSkills();
    const problems: string[] = [];
    let chipRemovedSinceAttach = false;
    // Each request is checked as it is made: the skill sent must be the chip shown, never one removed.
    const rounds: ScriptedRound[] = Array.from({ length: 40 }, () => () => {
      const sent = /<chosen_skill name="([^"]+)">/.exec(model.requests.at(-1)?.system ?? '')?.[1];
      const chip = chat.state().skill;
      if ((sent ?? null) !== (chip?.problem === null ? chip.name : null)) {
        problems.push(`sent ${sent ?? 'none'} while the chip showed ${chip?.name ?? 'none'}`);
      }
      if (sent !== undefined && chipRemovedSinceAttach) problems.push(`sent removed ${sent}`);
      return (async function* () {
        yield { type: 'text' as const, text: 'Answer.' };
      })();
    });
    const { chat, model, fixture } = session({ rounds, skill: held.port });
    const pending: Promise<unknown>[] = [];
    const trace: string[] = [];
    let questions = 0;
    for (let step = 0; step < 25; step += 1) {
      const what = steps[Math.floor(random() * steps.length)] ?? 'send';
      trace.push(what);
      if (what === 'attach-review' || what === 'attach-standup') {
        chipRemovedSinceAttach = false;
        pending.push(chat.attachSkill(what === 'attach-review' ? 'weekly-review' : 'standup'));
      } else if (what === 'remove') {
        chipRemovedSinceAttach = true;
        chat.removeSkill();
      } else if (what === 'send' || what === 'send-skill') {
        questions += 1;
        // A /name send attaches its skill too.
        if (what === 'send-skill') chipRemovedSinceAttach = false;
        const text = `Question ${questions}?`;
        pending.push(chat.send(what === 'send' ? text : `/weekly-review ${text}`));
      } else if (what === 'answer-read') {
        held.answerNext(VAULT);
      } else if (what === 'stop') {
        chat.stop();
      } else {
        chipRemovedSinceAttach = false;
        chat.newChat();
      }
      await settle();
    }
    // Let everything land.
    for (let guard = 0; guard < 200 && (held.pending() > 0 || guard < 3); guard += 1) {
      held.answerNext(VAULT);
      await settle();
    }
    await Promise.allSettled(pending);
    await settle();

    const state = chat.state();
    if (state.busy) problems.push('still busy once everything settled');
    const shown = userTexts(state.items);
    if (new Set(shown).size !== shown.length) problems.push(`a question shown twice: ${shown}`);
    const ids = state.items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) problems.push('an item id twice');
    // "Used the skill" exactly for the answers asked with one, in the chat now showing.
    if (state.chatPath !== null) {
      const note = fixture.files.get(state.chatPath)?.text ?? '';
      const used = note.match(/Used the skill /g)?.length ?? 0;
      const answers = state.items.filter((item) => item.kind === 'assistant').length;
      if (used > answers) problems.push(`${used} skill lines for ${answers} answers`);
    }
    return { problems, trace };
  }

  it.each([
    ['without Stop', STEPS.filter((step) => step !== 'stop'), 120],
    ['with Stop', STEPS, 60],
  ] as const)(
    'keeps every invariant over seeded sequences, %s',
    async (_, steps, runs) => {
      const failures: string[] = [];
      for (let seed = 1; seed <= runs; seed += 1) {
        const { problems, trace } = await run(635_000 + seed, steps);
        if (problems.length > 0) failures.push(`seed ${seed}: ${problems.join('; ')} [${trace}]`);
      }
      expect(failures).toEqual([]);
    },
    30_000,
  );
});
