// @vitest-environment jsdom
/**
 * Work that starts by itself waits for the vault's settings (#901, review of
 * #908): until the settings note answers, the off list is empty, so a runner
 * or listener of a switchable feature reading `offered` would start for a
 * feature the file switches off. Here the settings read resolves late, on
 * the test's word, while the index is ready and Kindle is connected.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  apiFixture,
  entryPointsOffered,
  fakeIndexPort,
  fakeMarkdown,
  fakeSlack,
  fakeVaultFs,
  recordingActivity,
  type KindleSync,
  type SlackCall,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { DESKTOP_CAPABILITIES, type KindleSyncRecord } from '@dfai/domain';
import {
  SLACK_PERMALINK,
  slackPermalinkAnswer,
  slackRepliesAnswer,
  slackUserAnswer,
} from '@dfai/domain/testing';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { useKindleSync, type KindleHost } from '../kindle/use-kindle-sync.ts';
import { useSlackPaste } from '../slack/use-slack-paste.ts';
import { useFeatures } from './use-features.ts';

const SETTINGS = '.atlas/settings.md';
const VAULT = '/Users/mara/Vault';
const platform = entryPointsOffered(DESKTOP_CAPABILITIES);
const CONNECTED: KindleSyncRecord = { connected: true, lastHoldAt: null, last: null };

/** A vault whose settings note answers only when `answer` is called. */
function lateSettings(text: string) {
  let answer: () => void = () => {};
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const fs = fakeVaultFs({
    readNotes: async (paths) => {
      if (!paths.includes(SETTINGS)) return [];
      await answered;
      return [{ path: SETTINGS, text, modified: 1, size: text.length }];
    },
  });
  return { fs, answer };
}

/** Kindle, connected and on for `VAULT`, counting its syncs. */
function kindleHost() {
  const syncs: string[] = [];
  let record = CONNECTED;
  const sync: KindleSync = async () => {
    syncs.push('sync');
    return { kind: 'synced', books: [], added: 0 };
  };
  const kindle: KindleHost = {
    notebook: {
      fetchLibrary: () => Promise.reject(new Error('not here')),
      fetchAnnotations: () => Promise.reject(new Error('not here')),
    },
    session: { connect: async () => {}, disconnect: async () => {} },
    sync,
    delay: { wait: async () => {} },
    records: { read: () => record, write: (next) => void (record = next) },
    vaults: { isOn: () => true, set: () => {} },
  };
  return { kindle, syncs };
}

const settle = async () => {
  for (let turn = 0; turn < 6; turn += 1) await act(async () => {});
};

function renderKindle(settingsText: string) {
  const settings = lateSettings(settingsText);
  const { kindle, syncs } = kindleHost();
  const { wrapper } = queryWrapper();
  const activity = recordingActivity();
  renderHook(
    () => {
      const { working } = useFeatures({
        platform,
        fs: settings.fs,
        markdown: remarkMarkdown,
        vaultKey: VAULT,
        activity,
      });
      return useKindleSync({
        kindle,
        fs: fakeVaultFs(),
        markdown: {
          frontmatterProperties: () => ({}),
          noteBlocks: () => ({ quotes: [], hidden: [] }),
        },
        index: fakeIndexPort(),
        openNotes: { state: () => 'closed', reload: () => {} },
        rng: { next: () => 0.5 },
        clock: { now: () => 0, today: () => '2026-11-17' },
        vaultKey: VAULT,
        indexReady: true,
        onWrote: () => {},
        enabled: working.kindleSync,
      });
    },
    { wrapper },
  );
  return { syncs, answer: settings.answer };
}

describe('Kindle sync waits for the settings read', () => {
  it.each([['kindle'], ['reading']])(
    'never syncs for a vault whose settings switch off %s, before the read answers or after',
    async (off) => {
      const { syncs, answer } = renderKindle(`---\nfeaturesOff: [${off}]\n---\n`);
      await settle();
      expect(syncs).toEqual([]);
      answer();
      await settle();
      expect(syncs).toEqual([]);
    },
  );

  it('syncs once the read says Kindle is on, and not before', async () => {
    const { syncs, answer } = renderKindle('---\nquickAdd: [task]\n---\n');
    await settle();
    expect(syncs).toEqual([]);
    answer();
    await settle();
    expect(syncs).toEqual(['sync']);
  });
});

const answering = (call: SlackCall): unknown => {
  if (call.method === 'auth.test') return { ok: true, user_id: 'U0MARAQ111', user: 'mara' };
  if (call.method === 'conversations.replies') return slackRepliesAnswer();
  if (call.method === 'chat.getPermalink') return slackPermalinkAnswer();
  return slackUserAnswer(call.query['user'] ?? '');
};

function renderSlack(settingsText: string) {
  const settings = lateSettings(settingsText);
  const api = apiFixture({ files: {} });
  const slack = fakeSlack(answering, { hasToken: true });
  const { wrapper } = queryWrapper();
  const activity = recordingActivity();
  const hook = renderHook(
    () => {
      const { working } = useFeatures({
        platform,
        fs: settings.fs,
        markdown: remarkMarkdown,
        vaultKey: VAULT,
        activity,
      });
      return useSlackPaste(
        {
          slack,
          capture: {
            fs: api.fs,
            markdown: fakeMarkdown(),
            index: { query: async () => ({ columns: [], rows: [], truncated: false }) },
          },
          vault: VAULT,
          timeZone: () => 'UTC',
          openNote: () => {},
        },
        working.slackLinkOffer,
      );
    },
    { wrapper },
  );
  return { slack, hook, answer: settings.answer };
}

/** Pastes `text` into a note's editor; whether anything stopped it reaching the editor. */
function pasteIntoNote(text: string): ClipboardEvent {
  const editor = document.body.appendChild(document.createElement('div'));
  editor.className = 'ProseMirror';
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
  editor.dispatchEvent(event);
  editor.remove();
  return event;
}

const reads = (slack: ReturnType<typeof fakeSlack>) =>
  slack.calls.filter((call) => call.method === 'conversations.replies');

describe('the Slack paste listener waits for the settings read', () => {
  it('reads nothing from Slack for a paste in a vault with Slack capture off, before or after', async () => {
    const { slack, hook, answer } = renderSlack('---\nfeaturesOff: [slack]\n---\n');
    await settle();
    expect(pasteIntoNote(SLACK_PERMALINK).defaultPrevented).toBe(false);
    await settle();
    expect(reads(slack)).toEqual([]);
    answer();
    await settle();
    pasteIntoNote(SLACK_PERMALINK);
    await settle();
    expect(reads(slack)).toEqual([]);
    expect(hook.result.current.view).toBeNull();
  });

  it('takes no paste before the read answers with Slack on, and the first one after', async () => {
    const { slack, hook, answer } = renderSlack('---\nquickAdd: [task]\n---\n');
    await settle();
    pasteIntoNote(SLACK_PERMALINK);
    await settle();
    expect(reads(slack)).toEqual([]);
    expect(hook.result.current.view).toBeNull();
    answer();
    await settle();
    pasteIntoNote(SLACK_PERMALINK);
    await settle();
    expect(reads(slack)).toHaveLength(1);
    expect(hook.result.current.view).not.toBeNull();
  });
});
