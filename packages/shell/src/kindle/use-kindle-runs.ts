import { useEffect, useMemo } from 'react';
import {
  literatureNoteKindleSink,
  runKindleSync,
  type KindleSyncRun,
  type KindleSyncWhy,
} from '@dfai/application';
import {
  KINDLE_AUTO_SYNC_INTERVAL_MS,
  KINDLE_NOT_INTO_VAULT_MESSAGE,
  type KindleSyncRecord,
} from '@dfai/domain';
import { useSteadyCallback } from '@dfai/ui';
import type { KindleWindowOptions } from './use-kindle-sync.ts';

/**
 * The runs of Kindle sync for the window (#508, ADR-0044): the automatic one,
 * once the open vault's index is ready and then every four hours, and the one
 * the person asks for. Both write only into a vault the person turned Kindle
 * sync on for; asking for one in any other says so.
 */
export function useKindleRuns({
  options,
  intoVault,
  setRecord,
  say,
}: {
  readonly options: KindleWindowOptions;
  readonly intoVault: boolean;
  readonly setRecord: (record: KindleSyncRecord) => void;
  readonly say: (message: string) => void;
}): { readonly asked: () => Promise<void> } {
  const { kindle, fs, markdown, index, openNotes, rng, clock, vaultKey, indexReady } = options;
  const sink = useMemo(
    () => literatureNoteKindleSink({ fs, markdown, index, openNotes, rng, clock }),
    [fs, markdown, index, openNotes, rng, clock],
  );
  const runPorts = useMemo(
    () => ({
      sync: kindle.sync,
      records: kindle.records,
      ports: {
        source: kindle.notebook,
        sink,
        clock,
        delay: kindle.delay,
        ...(vaultKey !== null && { vault: vaultKey }),
      },
    }),
    [kindle, sink, clock, vaultKey],
  );

  const settled = useSteadyCallback((run: KindleSyncRun, why: KindleSyncWhy) => {
    if (run.kind === 'skipped') return;
    setRecord(run.record);
    if (run.kind === 'ran' && run.report.kind !== 'unrecognised' && run.report.added > 0) {
      options.onWrote();
    }
    const said = run.record.last?.message;
    if (why === 'asked' && said !== undefined) say(said);
  });

  const automatic = useSteadyCallback(async () => {
    settled(await runKindleSync(runPorts, 'automatic'), 'automatic');
  });

  const asked = useSteadyCallback(async () => {
    if (!intoVault) say(KINDLE_NOT_INTO_VAULT_MESSAGE);
    else settled(await runKindleSync(runPorts, 'asked'), 'asked');
  });

  // Only a vault the person turned it on for has a timer; turning it off clears the timer.
  useEffect(() => {
    if (vaultKey === null || !indexReady || !intoVault) return undefined;
    void automatic();
    const timer = window.setInterval(() => void automatic(), KINDLE_AUTO_SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [vaultKey, indexReady, intoVault, automatic]);

  return useMemo(() => ({ asked }), [asked]);
}
