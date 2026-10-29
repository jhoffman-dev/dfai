// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  AFTER_A_MEETING_PROMPT,
  createVaultPath,
  type AutomationRule,
  type LogEntry,
} from '@dfai/domain';
import type { AutomationListing, RuleQueryPorts } from '@dfai/application';
import {
  createAutomationsStore,
  publishAutomations,
  type AutomationsController,
} from '../automations/automations-store.ts';
import {
  readPostProcessing,
  rulesTakeFrom,
  usePostProcessingNews,
} from './post-processing-facts.ts';

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
const clock = {
  today: () => '2026-10-08',
  localNow: () => '2026-10-08T09:00:00',
  now: () => Date.parse('2026-10-08T09:00:00Z'),
};

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

describe('rulesTakeFrom (#637 attack)', () => {
  const asked = { paths: [createVaultPath('Meetings/A.md')], generation: 3 };

  it('asks nothing while the index is not ready, nor before the rules are read', async () => {
    const store = createAutomationsStore();
    const take = vi.fn(async () => ({ paths: new Set<string>(), from: '' }));
    const ports = {} as RuleQueryPorts;
    const ready = { now: false };
    const ask = rulesTakeFrom({ store, clock, ports, indexReady: () => ready.now, take });

    publishAutomations(store, controller(listing([])));
    expect(await ask(asked)).toBeNull();
    ready.now = true;
    publishAutomations(store, null);
    expect(await ask(asked)).toBeNull();
    expect(take).not.toHaveBeenCalled();
  });

  it('asks with the rules last read, on each rule’s day, once the index is ready', async () => {
    const store = createAutomationsStore();
    const answer = { paths: new Set(['Meetings/A.md']), from: '2026-09-24' };
    const take = vi.fn<
      (args: { todayOf: (rule: AutomationRule) => string }) => Promise<typeof answer>
    >(async () => answer);
    const ports = {} as RuleQueryPorts;
    publishAutomations(store, controller(listing([])));
    const ask = rulesTakeFrom({ store, clock, ports, indexReady: () => true, take });

    expect(await ask(asked)).toBe(answer);
    const [args] = take.mock.calls[0] as unknown as [
      Parameters<typeof take>[0] & Record<string, unknown>,
    ];
    expect(args).toMatchObject({ ports, generation: 3, paths: asked.paths });
    expect((args as { todayOf: (rule: AutomationRule) => string }).todayOf(RULE)).toBe(
      '2026-10-08',
    );
  });
});
