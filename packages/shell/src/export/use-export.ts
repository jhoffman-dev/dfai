import { useLayoutEffect, useRef, useState } from 'react';
import {
  createExportStore,
  exportCommands,
  type ExportCommands,
  type ExportDeps,
  type ExportStore,
} from './export-flow.ts';

/**
 * Exporting notes for the window (#501): one store for the dialog, and
 * commands that stay the same function for the window's life — the panes,
 * the peek, ⌘K and a view's chosen rows are handed them — while reading the
 * vault open at the moment they run.
 */
export function useExport(deps: ExportDeps): { store: ExportStore; commands: ExportCommands } {
  const latest = useRef(deps);
  useLayoutEffect(() => {
    latest.current = deps;
  });
  const [exporting] = useState(() => {
    const store = createExportStore();
    return { store, commands: exportCommands(store, () => latest.current) };
  });
  return exporting;
}
