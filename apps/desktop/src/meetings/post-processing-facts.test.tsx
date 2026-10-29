// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  AFTER_A_MEETING_PROMPT,
  createVaultPath,
  type AutomationRule,
  type LogEntry,
} from '@dfai/domain';
import type { AutomationListing } from '@dfai/application';
import {
  createAutomationsStore,
  publishAutomations,
  type AutomationsController,
} from '../automations/automations-store.ts';
import { readPostProcessing, usePostProcessingNews } from './post-processing-facts.ts';

/** #182: what the meeting import reads of the automations runner, without the window drawing. */

const RULE: AutomationRule = {
  id: 'after-a-meeting',
  path: createVaultPath('.atlas/automations/After a meeting.md'),
  name: 'After a meeting',
  enabled: true,
  when: { kind: 'note', type: 'meeting', on: ['created'] },
  which: 'FROM meeting',
  olderThanDays: null,
  action: {
    kind: 'claude',
    prompt: AFTER_A_MEETING_PROMPT,
    tools: [],
    output: { kind: 'proposals', schema: 'meeting-digest' },
    apply: 'mine',
  },
};
const ran = (path: string): LogEntry => ({
  kind: 'run',
  at: '2026-10-08T09:00:00',
  trigger: 'note',
  done: [],
  left: [],
  capped: false,
  versions: [{ path: createVaultPath(path), digest: 'd', wrote: false }],
});
const listing = (log: LogEntry[]): AutomationListing => ({
  automations: [{ rule: RULE, log, ledger: null, idWritten: true }],
  broken: [],
});
const controller = (
  read: AutomationListing,
  pauses: Map<
    string,
    { reason: string; failures: number; retryAt: null; unavailable?: string }
  > = new Map(),
) => ({ listing: read, pauses }) as unknown as AutomationsController;
const clock = { today: () => '2026-10-08' };

describe('post-processing facts from the automations store (#182)', () => {
  it('reads the ledger of what the rules last listed, and nothing before they are', () => {
    const store = createAutomationsStore();
    expect(readPostProcessing(store, clock).summarising).toBe(false);

    publishAutomations(store, controller(listing([ran('Meetings/A.md')])));

    expect(readPostProcessing(store, clock)).toMatchObject({
      summarising: true,
      answered: new Set(['Meetings/A.md']),
    });
  });

  it('moves its mark when what was answered moves, and says why the step cannot reach Claude', () => {
    const store = createAutomationsStore();
    publishAutomations(store, controller(listing([])));
    const hook = renderHook(() => usePostProcessingNews(store, clock));
    const before = hook.result.current.mark;
    expect(hook.result.current.unavailable).toBeNull();

    act(() =>
      publishAutomations(
        store,
        controller(
          listing([ran('Meetings/A.md')]),
          new Map([
            [
              'after-a-meeting',
              { reason: 'r', failures: 1, retryAt: null, unavailable: 'Fix: claude auth login' },
            ],
          ]),
        ),
      ),
    );

    expect(hook.result.current.mark).not.toBe(before);
    expect(hook.result.current.unavailable).toBe('Fix: claude auth login');
  });
});
