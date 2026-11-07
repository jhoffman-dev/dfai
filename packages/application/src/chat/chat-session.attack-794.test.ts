import { describe, expect, it } from 'vitest';
import { EMPTY_PROFILE, type ModelUsage } from '@dfai/domain';
import { apiFixture, TODAY } from '../testing/api-fixture.ts';
import { blockMarkdown } from '../testing/block-markdown.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeModel, type ScriptedRound } from '../testing/fake-model.ts';
import { createChatSession } from './chat-session.ts';
import { ModelProviderError } from './ports.ts';
import { acceptProposal, undoProposal } from './proposals.ts';
import { createChatToolbox } from './toolbox.ts';

/**
 * Attack on PR #794 (#788): a turn whose provider fails after a round that
 * reported what it spent still spent those tokens; Activity must say so.
 */

const USAGE: ModelUsage = { input: 9000, cacheCreation: 2100, cacheRead: 30_100, output: 2140 };

function session(rounds: ScriptedRound[]) {
  const fixture = apiFixture({ files: { 'Plan.md': 'Intro.\n' }, markdown: blockMarkdown() });
  const markdown = blockMarkdown();
  let ids = 0;
  const newId = () => `id-${(ids += 1)}`;
  const openNotes = { state: () => 'closed' as const, reload: () => {} };
  const activity = recordingActivity();
  const model = fakeModel(rounds);
  const chat = createChatSession({
    provider: () => model,
    model: () => 'claude-opus-5-5',
    profile: () => Promise.resolve(EMPTY_PROFILE),
    toolbox: () => createChatToolbox({ api: fixture.deps, fs: fixture.fs, markdown, newId }),
    clock: { today: () => TODAY, now: () => 0, localNow: () => `${TODAY}T09:00:00` },
    vault: () => ({ fs: fixture.fs, notePaths: [] }),
    accept: (proposal) => acceptProposal({ fs: fixture.fs, openNotes, proposal }),
    undo: (applied) => undoProposal({ fs: fixture.fs, openNotes, applied }),
    skill: () => Promise.resolve({ kind: 'missing' }),
    stamp: () => '2026-09-22 09:00',
    newId,
    activity,
  });
  return { chat, activity };
}

describe('a chat turn that fails after spending tokens (attack #794)', () => {
  it.fails('still records what its rounds spent in Activity when round 2 throws', async () => {
    const { chat, activity } = session([
      [
        {
          type: 'tool_call',
          call: { id: 'c1', name: 'atlas_read_note', input: { path: 'Plan.md' } },
        },
        { type: 'usage', usage: USAGE },
      ],
      new ModelProviderError('failed', 'Claude Code could not answer.'),
    ]);
    await chat.send('What is in my secret plan?');
    const messages = activity.reports.map((report) => report.message);
    // Observed: only "turnFailed" is recorded; the 41k in / 2.1k out of round 1 vanish.
    expect(messages.some((message) => /\b\d+ rounds?\b/.test(message))).toBe(true);
  });
});
