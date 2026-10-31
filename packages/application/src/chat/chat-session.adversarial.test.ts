import { describe, expect, it } from 'vitest';
import { createVaultPath, EMPTY_PROFILE } from '@dfai/domain';
import type { ModelEvent } from './ports.ts';
import { apiFixture, TODAY } from '../testing/api-fixture.ts';
import { blockMarkdown } from '../testing/block-markdown.ts';
import { fakeModel, type ScriptedRound } from '../testing/fake-model.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { createChatSession, type ChatItem } from './chat-session.ts';
import { acceptProposal, undoProposal } from './proposals.ts';
import { createChatToolbox } from './toolbox.ts';

/**
 * Adversarial (P27, ADR-0021): the session's promises under double clicks and
 * interleaved flows — nothing is written but what one Accept asked for, and
 * one conversation never leaks into the next.
 */

function session(rounds: ScriptedRound[]) {
  const fixture = apiFixture({ files: { 'Plan.md': 'Intro.\n' }, markdown: blockMarkdown() });
  const markdown = blockMarkdown();
  const model = fakeModel(rounds);
  let ids = 0;
  const newId = () => `id-${(ids += 1)}`;
  const openNotes = { state: () => 'closed' as const, reload: () => {} };
  const chat = createChatSession({
    provider: () => model,
    model: () => 'claude-opus-5-5',
    profile: () => Promise.resolve(EMPTY_PROFILE),
    toolbox: () => createChatToolbox({ api: fixture.deps, fs: fixture.fs, markdown, newId }),
    clock: { today: () => TODAY, now: () => 0, localNow: () => `${TODAY}T09:00:00` },
    vault: () => ({ fs: fixture.fs, notePaths: [...fixture.files.keys()].map(createVaultPath) }),
    accept: (proposal) =>
      acceptProposal({
        fs: fixture.fs,
        openNotes,
        proposal,
      }),
    undo: (applied) => undoProposal({ fs: fixture.fs, openNotes, applied }),
    skill: () => Promise.resolve({ kind: 'missing' as const }),
    stamp: () => '2026-09-22 09:00',
    activity: recordingActivity(),
    newId,
  });
  return { chat, fixture };
}

const proposalOf = (items: readonly ChatItem[]) => {
  const found = items.find((item) => item.kind === 'proposal');
  if (found?.kind !== 'proposal') throw new Error('no proposal in the transcript');
  return found;
};

describe('a chat session (adversarial)', () => {
  it('a double-clicked Accept on a proposed note creates one note, not two', async () => {
    const { chat, fixture } = session([
      [
        {
          type: 'tool_call',
          call: { id: 'c1', name: 'propose_note', input: { title: 'Idea', body: 'x' } },
        },
      ],
      [{ type: 'text', text: 'Proposed.' }],
    ]);
    await chat.send('Make a note');
    const id = proposalOf(chat.state().items).id;

    await Promise.all([chat.accept(id), chat.accept(id)]);

    const ideas = [...fixture.files.keys()].filter((path) => path.startsWith('Idea'));
    expect(ideas).toEqual(['Idea.md']);
  });

  it('a new chat started while a turn is running keeps nothing of that turn', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    async function* slow(): AsyncIterable<ModelEvent> {
      await gate;
      yield { type: 'text', text: 'late answer' };
    }
    const { chat, fixture } = session([() => slow(), [{ type: 'text', text: 'second' }]]);

    const first = chat.send('Old question');
    chat.newChat();
    release();
    await first;

    // The abandoned turn is written to Chats/ as a chat of its own, and the
    // new conversation adopts that note: its next turn is appended there.
    expect(chat.state().chatPath).toBeNull();
    expect([...fixture.files.keys()].filter((path) => path.startsWith('Chats/'))).toEqual([]);
  });

  it('a turn left behind by a new chat does not end, or stop, the turn that replaced it', async () => {
    let releaseOld = () => {};
    const oldGate = new Promise<void>((resolve) => (releaseOld = resolve));
    let oldAsked = () => {};
    const oldStarted = new Promise<void>((resolve) => (oldAsked = resolve));
    async function* old(): AsyncIterable<ModelEvent> {
      oldAsked();
      await oldGate;
      yield { type: 'text', text: 'late answer' };
    }
    let newSignal: AbortSignal | null = null;
    let releaseNew = () => {};
    const newGate = new Promise<void>((resolve) => (releaseNew = resolve));
    async function* current(signal: AbortSignal): AsyncIterable<ModelEvent> {
      newSignal = signal;
      await newGate;
      yield { type: 'text', text: 'new answer' };
    }
    const { chat } = session([() => old(), (signal) => current(signal)]);

    const first = chat.send('Old question');
    // The turn reads the profile before it asks; it is left behind once it has asked.
    await oldStarted;
    chat.newChat();
    const second = chat.send('New question');
    releaseOld();
    await first;

    expect(chat.state().busy).toBe(true);
    expect(chat.state().items.map((item) => item.kind)).toEqual(['user']);
    chat.stop();
    expect(newSignal!.aborted).toBe(true);
    releaseNew();
    await second;
  });

  it('a turn left behind by a vault switch writes nothing to either vault', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    async function* slow(): AsyncIterable<ModelEvent> {
      await gate;
      yield { type: 'text', text: 'late answer' };
    }
    const first = apiFixture({ files: { 'Plan.md': 'Intro.\n' }, markdown: blockMarkdown() });
    const second = apiFixture({ files: { 'Other.md': 'Hi.\n' }, markdown: blockMarkdown() });
    let open = first;
    const model = fakeModel([() => slow()]);
    const chat = createChatSession({
      provider: () => model,
      model: () => 'claude-opus-5-5',
      profile: () => Promise.resolve(EMPTY_PROFILE),
      toolbox: () =>
        createChatToolbox({
          api: open.deps,
          fs: open.fs,
          markdown: blockMarkdown(),
          newId: () => 'x',
        }),
      clock: { today: () => TODAY, now: () => 0, localNow: () => `${TODAY}T09:00:00` },
      vault: () => ({ fs: open.fs, notePaths: [...open.files.keys()].map(createVaultPath) }),
      accept: () => Promise.reject(new Error('unused')),
      undo: () => Promise.reject(new Error('unused')),
      skill: () => Promise.resolve({ kind: 'missing' as const }),
      stamp: () => '2026-09-22 09:00',
      activity: recordingActivity(),
      newId: (() => {
        let ids = 0;
        return () => `id-${(ids += 1)}`;
      })(),
    });

    const turn = chat.send('Old question');
    open = second;
    chat.newChat();
    release();
    await turn;

    const chats = (files: ReadonlyMap<string, unknown>) =>
      [...files.keys()].filter((path) => path.startsWith('Chats/'));
    expect(chats(first.files)).toEqual([]);
    expect(chats(second.files)).toEqual([]);
  });

  it('a retried question is written to the chat note once', async () => {
    const { chat, fixture } = session([
      [{ type: 'text', text: 'First answer.' }],
      [{ type: 'text', text: 'Second answer.' }],
    ]);
    await chat.send('What is due?');
    await chat.retry();

    const path = chat.state().chatPath!;
    const note = fixture.files.get(path)?.text ?? '';
    expect(note.split('What is due?')).toHaveLength(2);
    expect(note).toContain('Second answer.');
  });

  it('a double-clicked Undo undoes once', async () => {
    const { chat } = session([
      [
        {
          type: 'tool_call',
          call: {
            id: 'c1',
            name: 'propose_edit',
            input: { path: 'Plan.md', append: 'More.' },
          },
        },
      ],
      [{ type: 'text', text: 'Proposed.' }],
    ]);
    await chat.send('Make a note');
    const id = proposalOf(chat.state().items).id;
    await chat.accept(id);
    await Promise.all([chat.undo(id), chat.undo(id)]);

    expect(proposalOf(chat.state().items)).toMatchObject({ state: 'undone', problem: null });
  });

  it('marks a proposal accepting while its write is under way', async () => {
    const { chat } = session([
      [
        {
          type: 'tool_call',
          call: { id: 'c1', name: 'propose_note', input: { title: 'Idea', body: 'x' } },
        },
      ],
      [{ type: 'text', text: 'Proposed.' }],
    ]);
    await chat.send('Make a note');
    const id = proposalOf(chat.state().items).id;
    const accepting = chat.accept(id);
    expect(proposalOf(chat.state().items).state).toBe('accepting');
    await accepting;
    expect(proposalOf(chat.state().items).state).toBe('accepted');
  });
});
