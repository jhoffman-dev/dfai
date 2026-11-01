// @vitest-environment jsdom
/**
 * Issue #8 ("nothing synced"): once sync is set up from Settings, the vault
 * sends its changes by itself and brings other Macs' in by itself — run
 * through the real `useSync`, the Mac's real git and a bare repository on
 * disk standing in for GitHub. Only the timers and the clock are the test's.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  fakeSleepClock,
  recordingActivity,
  scriptedFolders,
  type GitResult,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useSync, type SyncOptions } from './use-sync.ts';
import { SYNC_TICK_MS } from './use-sync-schedule.ts';
import {
  isolatedWorld,
  macAt,
  must,
  sh,
  TIMEOUT,
  vaultFsOf,
  type Env,
} from './two-macs.harness.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { toldNews } from '../reads/told-news.test-support.ts';

function handClock(start = Date.UTC(2026, 9, 4, 15, 40)) {
  let now = start;
  return {
    now: () => now,
    localNow: () => '2026-10-04T08:40:00',
    advance: (ms: number) => (now += ms),
  };
}

/** Moves the hand clock and the timers together, a tick at a time, as time passing would. */
async function wait(clock: ReturnType<typeof handClock>, ms: number) {
  for (let passed = 0; passed < ms; passed += SYNC_TICK_MS) {
    clock.advance(SYNC_TICK_MS);
    await act(async () => vi.advanceTimersByTime(SYNC_TICK_MS));
  }
}

/**
 * Waits on real time for a state: the test fakes only the sync's interval,
 * and git runs as a real process. vitest's own waiter keeps the real timers.
 */
const until = (check: () => unknown) => vi.waitFor(check, { timeout: 20_000, interval: 50 });

async function onGitHub(base: string, bare: string, env: Env): Promise<string[]> {
  const listed = await sh(base, ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main'], env);
  return listed.stdout.split('\n').filter((line) => line !== '');
}

afterEach(() => vi.useRealTimers());

describe('a vault set up from Settings syncs by itself (issue #8)', () => {
  it(
    'sends a change half a minute after it, and brings another Mac’s in within the minute',
    async () => {
      const { base, env, bare, trash } = await isolatedWorld();
      await must(base, ['init', '--quiet', '--bare', '--initial-branch=main', bare], env);
      const root = join(base, 'DFAI Vault');
      const mac = macAt({ name: 'Air', root, env, trash });
      await mac.write('Test Note.md', 'a note\n');
      await mac.write('.atlas/settings.md', '---\nquickAdd:\n  - task\n---\n\n# Settings\n');
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const clock = handClock();
      const edits = toldNews();
      const options: SyncOptions = {
        host: {
          git: () => mac.git,
          files: () => mac.syncFiles,
          folders: {
            ...scriptedFolders(),
            topLevelOf: (folder) => sh(folder, ['rev-parse', '--show-toplevel'], env),
          },
          github: {
            listRepositories: async (): Promise<GitResult> => ({ code: 1, stdout: '', stderr: '' }),
          },
          thisMac: { name: async () => 'Air', id: async () => 'mac-air' },
          pause: { read: () => false, write: () => {} },
          sleepClock: fakeSleepClock().port,
        },
        fs: vaultFsOf(mac),
        markdown: remarkMarkdown,
        vaultKey: root,
        edits: edits.feed,
        clock,
        activity: recordingActivity(),
        flushAll: async () => {},
        closing: { beforeClose: async () => () => {} },
        onPulled: () => {},
      };
      const hook = renderHook((props: SyncOptions) => useSync(props), {
        wrapper: queryWrapper().wrapper,
        initialProps: options,
      });
      await until(() => expect(hook.result.current.phase.kind).toBe('not-set-up'));

      act(() => hook.result.current.setUp({ kind: 'existing', url: bare }));
      await until(() => expect(hook.result.current.phase.kind).toBe('synced'));
      expect(await onGitHub(base, bare, env)).toContain('Test Note.md');

      // Push as you work: a new note goes up about half a minute after it is written.
      await mac.write('Later.md', 'written after setting up\n');
      act(() => edits.tell());
      await wait(clock, 40_000);
      await until(async () => expect(await onGitHub(base, bare, env)).toContain('Later.md'));

      // Pull every minute: another Mac's note comes in without anyone asking.
      const other = join(base, 'Laptop', 'vault');
      await mkdir(dirname(other), { recursive: true });
      await must(dirname(other), ['clone', '--quiet', '--', bare, 'vault'], env);
      await writeFile(join(other, 'From laptop.md'), 'from the laptop\n');
      await must(other, ['add', '--all'], env);
      await must(
        other,
        ['-c', 'user.name=L', '-c', 'user.email=l@x', 'commit', '--quiet', '-m', 'laptop'],
        env,
      );
      await must(other, ['push', '--quiet', 'origin', 'HEAD'], env);
      await wait(clock, 65_000);
      await until(async () => expect(await mac.read('From laptop.md')).toBe('from the laptop\n'));
      hook.unmount();
    },
    TIMEOUT,
  );
});
