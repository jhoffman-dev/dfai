import { useMemo } from 'react';
import { TYPE_ICONS, typeDeleteRefusal, type VaultPath } from '@dfai/domain';
import type { DefinedType } from '@dfai/application';
import { TypeEditor, type TypeDefaultView } from '@dfai/ui';
import { typeTabsShown } from '../types/type-tabs.ts';
import { useTypeEditor } from '../types/use-type-editor.ts';
import type { RowPorts } from './row-aside.tsx';

/** What the type editor in the aside hands to the window: its dialogs and pages. */
export interface TypeAsideWiring {
  /** Asks to put the type's file in the Trash, through the same question as any note. */
  readonly onDelete: (path: VaultPath) => void;
  /** Opens the template the type's new notes start as, made if it has none. */
  readonly onEditTemplate: (typeName: string) => void;
  /** Opens the type's own page: its default table while it has no views. */
  readonly onOpenType: (name: string) => void;
}

/**
 * The aside's Type tab (slice 12): the editor for the type the focused tab
 * shows, read from the panes' types and written as the full-page editor was
 * — each change made by the domain and written to the type file at once,
 * byte-preserving, against the file as it is read at the write. Mounted only
 * while the tab is shown, and afresh per type (keyed by name).
 */
export function TypeAside({
  type,
  ports,
  wiring,
}: {
  type: DefinedType;
  ports: RowPorts;
  wiring: TypeAsideWiring;
}) {
  const { pane } = ports;
  const editor = useTypeEditor({
    fs: pane.notes.fs,
    markdown: pane.notes.markdown,
    index: pane.index,
    openNotes: pane.editors,
    type,
    types: pane.types,
    onSaved: pane.onTypeSaved,
  });
  const shown = editor.draft ?? type;
  const targets = useMemo(
    () => pane.types.map(({ name, label }) => ({ name, label })),
    [pane.types],
  );
  const defaultView = useDefaultView({ type, ports, wiring });
  return (
    <TypeEditor
      type={shown}
      icons={TYPE_ICONS}
      targets={targets}
      prompt={editor.prompt}
      notice={editor.notice}
      onEdit={editor.edit}
      deletion={{ refusal: typeDeleteRefusal(shown), onDelete: () => wiring.onDelete(type.path) }}
      onOpenTemplate={() => wiring.onEditTemplate(type.name)}
      {...(defaultView !== undefined && { defaultView })}
    />
  );
}

/** The type's first tab: a saved view, or its default table while it has none. */
function useDefaultView({
  type,
  ports,
  wiring,
}: {
  type: DefinedType;
  ports: RowPorts;
  wiring: TypeAsideWiring;
}): TypeDefaultView | undefined {
  const { savedViews, viewPaths } = ports.pane;
  const first = useMemo(
    () => typeTabsShown({ savedViews, takenViewPaths: viewPaths }, type)[0],
    [savedViews, viewPaths, type],
  );
  if (first === undefined) return undefined;
  return {
    title: first.title,
    onOpen: () => (first.virtual ? wiring.onOpenType(type.name) : ports.openNote(first.path)),
  };
}
