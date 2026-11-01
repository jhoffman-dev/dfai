import { memo } from 'react';
import { useStore } from 'zustand';
import type { ExportFormat } from '@dfai/domain';
import { ExportDialog } from '@dfai/ui';
import type { ExportCommands, ExportStore } from './export-flow.ts';

/**
 * The export question, drawn from its own store (ADR-0040): a step of the
 * export draws this dialog and nothing else in the window.
 */
export const ExportSlot = memo(function ExportSlot({
  store,
  commands,
  fallbackFocus,
  formats,
}: {
  store: ExportStore;
  commands: ExportCommands;
  /** The formats this platform offers. */
  formats: readonly ExportFormat[];
  fallbackFocus?: () => HTMLElement | null;
}) {
  const flow = useStore(store, (state) => state.flow);
  if (flow === null) return null;
  return (
    <ExportDialog
      subject={flow.subject}
      state={flow.state}
      onExport={commands.run}
      onClose={commands.close}
      formats={formats}
      {...(fallbackFocus !== undefined && { fallbackFocus })}
    />
  );
});
