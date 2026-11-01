import { memo } from 'react';
import { useStore } from 'zustand';
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
}: {
  store: ExportStore;
  commands: ExportCommands;
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
      {...(fallbackFocus !== undefined && { fallbackFocus })}
    />
  );
});
