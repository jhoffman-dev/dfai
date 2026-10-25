import { describe, expect, it } from 'vitest';
import { createVaultPath, EMPTY_PROFILE, type VaultPath } from '@dfai/domain';
import type { VaultFsPort } from '../vault/ports.ts';
import { apiFixture, TODAY } from '../testing/api-fixture.ts';
import { blockMarkdown } from '../testing/block-markdown.ts';
import { fakeModel, type ScriptedRound } from '../testing/fake-model.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { createChatSession, type ChatItem } from './chat-session.ts';
import { acceptProposal, undoProposal } from './proposals.ts';
import { createChatToolbox } from './toolbox.ts';

/**
 * Attack on PR #557 (#548): Past chats, in the sidebar and in Ask, opens a
 * chat with `session.open`. Its note is read before the session is changed,
 * so a pick races what the person does while that read is under way.
 */

const chatNote = (question: string, answer: string) =>
  `---\ntype: chat\n---\n\n## You\n\n${question}\n\n## Claude\n\n${answer}\n`;

/** Every read of a held path waits until its release is called. */
function holdingFs(fs: VaultFsPort) {
  const held = new Map<string, () => void>();
  const gates = new Map<string, Promise<void>>();
  const wrapped: VaultFsPort = {
    ...fs,
    readTextFile: async (path) => {
      const gate = gates.get(path);
      if (gate !== undefined) await gate;
      return fs.readTextFile(path);
    },
  };
  return {
    fs: wrapped,
    hold(path: string): () => void {
      gates.set(
        path,
        new Promise<void>((resolve) => {
          held.set(path, resolve);
        }),
      );
      return () => held.get(path)?.();
    },
  };
}

function session(rounds: ScriptedRound[]) {
  const fixture = apiFixture({
    files: {
      'Plan.md': 'Intro.\n',
      'Chats/Larkspur kickoff.md': chatNote('Larkspur kickoff', 'Mara owns it.'),
      'Chats/Quill rollout.md': chatNote('Quill rollout', 'Tobias owns it.'),
    },
    markdown: blockMarkdown(),
  });
  const reads = holdingFs(fixture.fs);
  const markdown = blockMarkdown();
  const model = fakeModel(rounds);
  let ids = 0;
  const newId = () => `id-${(ids += 1)}`;
  const openNotes = { state: () => 'closed' as const, reload: () => {} };
  const chat = createChatSession({
    provider: () => model,
    model: () => 'claude-opus-5-5',
    profile: () => Promise.resolve(EMPTY_PROFILE),
    toolbox: () => createChatToolbox({ api: fixture.deps, fs: reads.fs, markdown, newId }),
    clock: { today: () => TODAY, now: () => 0, localNow: () => `${TODAY}T09:00:00` },
    vault: () => ({ fs: reads.fs, notePaths: [...fixture.files.keys()].map(createVaultPath) }),
    accept: (proposal) => acceptProposal({ fs: reads.fs, openNotes, proposal }),
    undo: (applied) => undoProposal({ fs: reads.fs, openNotes, applied }),
    stamp: () => '2026-09-22 09:00',
    activity: recordingActivity(),
    newId,
  });
  return { chat, fixture, model, hold: reads.hold };
}

const texts = (items: readonly ChatItem[]) =>
  items.map((item) => (item.kind === 'user' || item.kind === 'assistant' ? item.text : item.kind));

const KICKOFF: VaultPath = createVaultPath('Chats/Larkspur kickoff.md');
const ROLLOUT: VaultPath = createVaultPath('Chats/Quill rollout.md');

describe('opening a past chat (attack, PR #557)', () => {
  it('shows the chat picked last, when an earlier pick is read more slowly', async () => {
    const { chat, hold } = session([]);
    const releaseKickoff = hold(KICKOFF);

    const first = chat.open(KICKOFF);
    await chat.open(ROLLOUT);
    releaseKickoff();
    await first;

    expect(chat.state().chatPath).toBe(ROLLOUT);
    expect(texts(chat.state().items)).toEqual(['Quill rollout', 'Tobias owns it.']);
  });

  it('keeps a question sent while a picked chat is still being read', async () => {
    const { chat, hold, model } = session([[{ type: 'text', text: 'Due Friday.' }]]);
    const releaseKickoff = hold(KICKOFF);

    const opening = chat.open(KICKOFF);
    await chat.send('What is due this week?');
    releaseKickoff();
    await opening;

    // The model was asked and answered: the person's question and its answer
    // must not vanish because a pick made earlier landed afterwards.
    expect(model.requests).toHaveLength(1);
    expect(texts(chat.state().items)).toContain('What is due this week?');
  });

  it('says something when a chat is picked while a turn is streaming', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    async function* slow() {
      await gate;
      yield { type: 'text' as const, text: 'late answer' };
    }
    const { chat } = session([() => slow()]);

    const turn = chat.send('What is due?');
    const picked = chat.open(KICKOFF);
    // A pick that is not honoured is refused, so the caller can say why;
    // resolving quietly leaves Past chats closed and nothing changed.
    await expect(picked).rejects.toThrow();
    release();
    await turn;
  });
});
