import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isOutsideVault,
  parseDatasource,
  secretsUsedBy,
  sqliteFileReference,
  type Datasource,
} from '@dfai/domain';
import type {
  IndexPort,
  MarkdownPort,
  OpenNote,
  SourceRefresher,
  SourceReport,
  VaultFsPort,
} from '@dfai/application';
import type { SourcePorts } from './source-ports.ts';

const MINUTE_MS = 60_000;

/**
 * Runs the open note when that note is a source.
 *
 * The timer lives here rather than anywhere further in: a refresh needs a clock
 * and the vault, and neither belongs to the rules. `refreshSource` is handed the
 * time it ran, so what it does is the same every time it is given the same one.
 */
export function useSource({
  note,
  fs,
  markdown,
  index,
  sources,
  refresher,
  vaultRoot,
  setProperty,
  onChanged,
}: {
  note: OpenNote | null;
  fs: VaultFsPort;
  markdown: MarkdownPort;
  index: IndexPort;
  sources: SourcePorts;
  /** The window's one refresher, so the pane and the local API never refresh at once. */
  refresher: SourceRefresher;
  /** The open vault's absolute path, which a picked file is named relative to. */
  vaultRoot: string | null;
  /** Writes one property of the open note, as the properties panel does. */
  setProperty: (key: string, value: unknown) => void;
  /** Called after a refresh that wrote something, so the tree and index follow. */
  onChanged: () => void;
}): {
  source: Datasource | null;
  report: SourceReport | null;
  refreshing: boolean;
  refresh: () => void;
  /** The secrets the source sends, by name. */
  secrets: readonly string[];
  outsideVault: boolean;
  /** Picks a SQLite source's file; null for any other kind of source. */
  chooseFile: (() => void) | null;
  /** Why the last attempt to choose a file failed, or null. */
  fileProblem: string | null;
} {
  const source = useMemo(() => (note === null ? null : parseDatasource(note.properties)), [note]);
  const sourcePath = note?.path ?? null;
  const { http, sqlite } = sources;

  const [report, setReport] = useState<SourceReport | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  // A refresh in flight must not be joined by another: the second would plan
  // against notes the first has not finished writing.
  const running = useRef(false);

  const run = useCallback(async () => {
    // With no vault open there are no secrets to send and nowhere to write.
    if (source === null || sourcePath === null || vaultRoot === null || running.current) return;

    running.current = true;
    setRefreshing(true);
    // Null when the local API is refreshing this source already: its report is
    // not this pane's to show, and the notes it writes arrive as any change does.
    const finished = await refresher.refresh({
      fs,
      markdown,
      index,
      http,
      sqlite,
      sourcePath,
      source,
      vault: vaultRoot,
      now: Date.now(),
    });
    running.current = false;
    setRefreshing(false);
    if (finished === null) return;
    setReport(finished);

    if (finished.created + finished.replaced + finished.updated + finished.missing > 0) {
      onChanged();
    }
  }, [fs, markdown, index, http, sqlite, refresher, source, sourcePath, vaultRoot, onChanged]);

  // A new note means a new report: the last one describes a different source.
  useEffect(() => {
    setReport(null);
    setFileProblem(null);
  }, [sourcePath]);

  const interval = source?.interval ?? 0;

  // The timer fires the latest refresh without being rebuilt by it. Tying the
  // interval to `run` would restart — and so re-fire — every time a refresh
  // moved the index and the open note came back as a new object.
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  }, [run]);

  useEffect(() => {
    if (interval === 0) return;

    // Once on opening, because a subscription that waits a quarter of an hour
    // before its first refresh is a subscription you cannot trust to be current.
    void latest.current();
    const timer = setInterval(() => void latest.current(), interval * MINUTE_MS);
    return () => clearInterval(timer);
  }, [interval, sourcePath]);

  const chooseFile = useCallback(async () => {
    setFileProblem(null);
    let picked: string | null;
    try {
      picked = await sqlite.pick();
    } catch (cause) {
      // The dialog could not open, or the grant could not be kept: the note
      // keeps the file it had, and the panel says why.
      setFileProblem(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    // Cancelled: the note keeps the file it had.
    if (picked === null || vaultRoot === null) return;
    setProperty('file', sqliteFileReference({ picked, vaultRoot }));
  }, [sqlite, vaultRoot, setProperty]);

  return {
    source,
    report,
    refreshing,
    refresh: () => void run(),
    secrets: source === null ? [] : secretsUsedBy(source),
    outsideVault:
      source?.file !== null && source?.file !== undefined && isOutsideVault(source.file),
    chooseFile: source?.format === 'sqlite' ? () => void chooseFile() : null,
    fileProblem,
  };
}
