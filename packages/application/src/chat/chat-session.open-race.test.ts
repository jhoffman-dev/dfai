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
 * A past chat picked, whose note turns out to be gone, while the person has
 * already moved on (#557 review): the failed read of a pick nobody is waiting
 * for any more is not said, nor does it bring Past chats back over the chat
 * the person is in.
 */

const chatNote = (question: string, answer: string) =>
  `---\ntype: chat\n---\n\n## You\n\n${question}\n\n## Claude\n\n${answer}\n`;

const GONE: VaultPath = createVaultPath('Chats/Larkspur kickoff.md');
const ROLLOUT: VaultPath = createVaultPath('Chats/Quill rollout.md');

/** A vault whose read of `GONE` waits for `fail`, then fails as a deleted note's does. */
function session(rounds: ScriptedRound[] = []) {
  const fixture = apiFixture({
    files: {
      'Plan.md': 'Intro.\n',
      'Chats/Quill rollout.md': chatNote('Quill rollout', 'Tobias owns it.'),
    },
    markdown: blockMarkdown(),
  });
  let fail = () => {};
  const failed = new Promise<void>((resolve) => (fail = resolve));
  const fs: VaultFsPort = {
    ...fixture.fs,
    readTextFile: async (path) => {
      if (path !== GONE) return fixture.fs.readTextFile(path);
      await failed;
      throw new Error(`not_found: ${GONE}`);
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
    stamp: () => '2026-09-22 09:00',
    activity: recordingActivity(),
    newId,
  });
  return { chat, fail };
}

const texts = (items: readonly ChatItem[]) =>
  items.map((item) => (item.kind === 'user' || item.kind === 'assistant' ? item.text : item.kind));

describe('a picked chat whose note is gone, once the person has moved on', () => {
  it('is not said after another chat was picked', async () => {
    const { chat, fail } = session();
    const stale = chat.open(GONE);
    await chat.open(ROLLOUT);
    fail();
    await expect(stale).resolves.toBeUndefined();
    expect(texts(chat.state().items)).toEqual(['Quill rollout', 'Tobias owns it.']);
  });

  it('is not said after a new chat was begun', async () => {
    const { chat, fail } = session();
    const stale = chat.open(GONE);
    chat.newChat();
    fail();
    await expect(stale).resolves.toBeUndefined();
    expect(chat.state().items).toEqual([]);
  });

  it('is not said after a question was asked', async () => {
    const { chat, fail } = session([[{ type: 'text', text: 'Due Friday.' }]]);
    const stale = chat.open(GONE);
    await chat.send('What is due this week?');
    fail();
    await expect(stale).resolves.toBeUndefined();
    expect(texts(chat.state().items)).toEqual(['What is due this week?', 'Due Friday.']);
  });

  it('is still said when nothing has moved on', async () => {
    const { chat, fail } = session();
    const picked = chat.open(GONE);
    fail();
    await expect(picked).rejects.toThrow(`not_found: ${GONE}`);
  });
});
