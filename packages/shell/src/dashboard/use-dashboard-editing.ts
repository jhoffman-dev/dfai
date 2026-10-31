import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  defaultTitle,
  draftFromEntry,
  fromViewQuery,
  newWidgetDraft,
  optionsOfKind,
  widgetEntries,
  widgetProblems,
  withKind,
  withType,
  type ObjectType,
  type SavedViewSummary,
  type VaultPath,
  type WidgetDraft,
  type WidgetKind,
} from '@dfai/domain';
import {
  dashboardChange,
  previewWidget,
  type ActivityLog,
  type DashboardEdit,
  type IndexPort,
  type OpenNote,
  type WidgetResult,
} from '@dfai/application';
import {
  useNoteNames,
  type DashboardEditing,
  type OverlaySlot,
  type WidgetEditorProps,
} from '@dfai/ui';
import type { NotePorts } from '../notes/use-note.ts';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useChangeProperties } from '../query/use-view-writes.ts';
import { editorChoices } from './editor-choices.ts';

/** The widget being added (`entry` null) or edited, on the dashboard it belongs to. */
interface Sheet {
  readonly path: VaultPath;
  readonly entry: number | null;
  readonly draft: WidgetDraft;
}

/**
 * Editing the open dashboard: arranging it, and adding, editing and removing
 * its widgets in the side sheet.
 *
 * Every change is one write of the note's `widgets`, made through the pane
 * that holds the note, like any other property write. What was there before
 * is kept, so Cmd+Z can put it back.
 */
export function useDashboardEditing({
  note,
  isDashboard,
  ports,
  index,
  types,
  notePaths,
  savedViews,
  editors,
  activity,
  onChanged,
  editorSlot,
  inPeek = false,
}: {
  note: OpenNote | null;
  isDashboard: boolean;
  ports: NotePorts;
  index: IndexPort;
  types: readonly ObjectType[];
  /** Every note, so a query widget's preview resolves links as the dashboard does. */
  notePaths: readonly string[];
  savedViews: readonly SavedViewSummary[];
  editors: OpenEditors;
  /** Where an edit the dashboard gives up on is recorded. */
  activity: Pick<ActivityLog, 'inOpenVault'>;
  onChanged: () => void;
  /** The sheet's open state, held by the app's one-overlay rule. */
  editorSlot: OverlaySlot | undefined;
  /** Whether the dashboard is drawn in the center peek rather than a pane. */
  inPeek?: boolean;
}) {
  const path = isDashboard ? (note?.path ?? null) : null;
  // Held with the path they belong to, so opening another note leaves them behind.
  const [arrangingAt, setArrangingAt] = useState<VaultPath | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const arranging = path !== null && arrangingAt === path;
  const open = sheet !== null && sheet.path === path ? sheet : null;

  const changeProperties = useChangeProperties({
    editors,
    fs: ports.fs,
    markdown: ports.markdown,
    activity,
    onChanged,
    onError: setError,
  });
  const { edit, undo } = useEditHistory({ note, path, changeProperties, onEdit: setError });
  useUndoKey({ active: arranging, undo, inPeek });

  const openSheet = useCallback(
    (entry: number | null, draft: WidgetDraft) => {
      if (path === null) return;
      setSheet({ path, entry, draft });
      editorSlot?.onOpenChange(true);
    },
    [path, editorSlot],
  );
  const closeSheet = useCallback(() => {
    setSheet(null);
    editorSlot?.onOpenChange(false);
  }, [editorSlot]);

  const editing: DashboardEditing | undefined =
    path === null || note === null
      ? undefined
      : {
          arranging,
          error,
          onAdd: () =>
            openSheet(null, newWidgetDraft({ kind: 'number', type: types[0]?.name ?? '' })),
          onEdit: (widget) =>
            openSheet(widget.entry, draftFromEntry(widgetEntries(note.properties)[widget.entry])),
          onRemove: (widget) => edit({ kind: 'remove', entry: widget.entry }),
          onPlace: ({ widget, to, span }) => edit({ kind: 'place', entry: widget.entry, to, span }),
        };

  const sheetProps = useSheetProps({
    open,
    types,
    notePaths,
    savedViews,
    index,
    slot: editorSlot,
    onDraft: (draft) => setSheet((was) => (was === null ? was : { ...was, draft })),
    onSave: () => {
      if (open === null) return;
      edit(
        open.entry === null
          ? { kind: 'add', draft: open.draft }
          : { kind: 'update', entry: open.entry, draft: open.draft },
      );
      closeSheet();
    },
    onClose: closeSheet,
  });

  return {
    editing,
    sheet: editorSlot === undefined || editorSlot.open ? sheetProps : null,
    toggle:
      path === null
        ? null
        : {
            arranging,
            onToggle: () => setArrangingAt((was) => (was === path ? null : path)),
          },
  };
}

/** Writes each edit, keeping what the list was before it for undo. */
function useEditHistory({
  note,
  path,
  changeProperties,
  onEdit,
}: {
  note: OpenNote | null;
  path: VaultPath | null;
  changeProperties: ReturnType<typeof useChangeProperties>;
  /** Told as an edit starts, so the last one's failure stops being shown. */
  onEdit: (error: null) => void;
}) {
  const history = useRef<{ path: VaultPath | null; earlier: unknown[] }>({
    path: null,
    earlier: [],
  });

  const write = useCallback(
    (change: DashboardEdit) => {
      if (note === null || path === null) return;
      onEdit(null);
      changeProperties({ path: note.path, values: dashboardChange(change) });
    },
    [note, path, changeProperties, onEdit],
  );

  const edit = useCallback(
    (change: DashboardEdit) => {
      if (note === null || path === null) return;
      if (history.current.path !== path) history.current = { path, earlier: [] };
      history.current.earlier.push(note.properties['widgets']);
      write(change);
    },
    [note, path, write],
  );

  const undo = useCallback(() => {
    const { path: editedAt, earlier } = history.current;
    if (editedAt !== path || earlier.length === 0) return;
    write({ kind: 'restore', widgets: earlier.pop() });
  }, [path, write]);

  return { edit, undo };
}

/**
 * Cmd+Z (Ctrl+Z elsewhere) while the dashboard is being arranged. A text field
 * keeps the key for its own undo.
 */
function useUndoKey({
  active,
  undo,
  inPeek,
}: {
  active: boolean;
  undo: () => void;
  inPeek: boolean;
}) {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const chord = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
      if (!chord || event.key.toLowerCase() !== 'z' || takesText(event.target)) return;
      // Pressed in the other layer — the peek over this dashboard, or the page under it — it is not this one's.
      if (pressedInPeek(event.target) !== inPeek) return;
      event.preventDefault();
      undo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, undo, inPeek]);
}

/** Whether a key was pressed in the center peek (`PeekDialog`'s popup is `.peek`). */
function pressedInPeek(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.peek') !== null;
}

function takesText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/** Everything the side sheet draws, worked out from the draft. */
function useSheetProps({
  open,
  types,
  notePaths,
  savedViews,
  index,
  slot,
  onDraft,
  onSave,
  onClose,
}: {
  open: Sheet | null;
  types: readonly ObjectType[];
  notePaths: readonly string[];
  savedViews: readonly SavedViewSummary[];
  index: IndexPort;
  slot: OverlaySlot | undefined;
  onDraft: (draft: WidgetDraft) => void;
  onSave: () => void;
  onClose: () => void;
}): WidgetEditorProps | null {
  const draft = open?.draft ?? null;
  const preview = usePreview({ draft, index, types, notePaths });
  const choices = useMemo(
    () => (draft === null ? null : editorChoices({ draft, types, savedViews })),
    [draft, types, savedViews],
  );
  if (open === null || draft === null || choices === null) return null;

  return {
    mode: open.entry === null ? 'add' : 'edit',
    draft,
    options: optionsOfKind(draft.kind),
    defaultTitle: defaultTitle(draft.kind, draft.type || 'widget'),
    problems: widgetProblems(
      draft,
      types.length === 0 ? {} : { knownTypes: types.map((type) => type.name) },
    ),
    preview,
    ...choices,
    onChange: onDraft,
    onKind: (kind: WidgetKind) => onDraft(withKind(draft, kind)),
    onType: (type: string) => onDraft(withType(draft, type)),
    onStartFromView: (viewPath: string) => {
      const view = savedViews.find((candidate) => candidate.path === viewPath);
      if (view !== undefined) onDraft(fromViewQuery(draft, view.query));
    },
    onSave,
    onClose,
    ...(slot !== undefined && { slot }),
  };
}

/**
 * The draft run as the dashboard would run it. The last good picture stays up
 * while the next is worked out, so the preview does not blink on each key.
 */
function usePreview({
  draft,
  index,
  types,
  notePaths,
}: {
  draft: WidgetDraft | null;
  index: IndexPort;
  types: readonly ObjectType[];
  notePaths: readonly string[];
}): WidgetResult | null {
  const [preview, setPreview] = useState<WidgetResult | null>(null);
  const names = useNoteNames();
  useEffect(() => {
    if (draft === null) return;
    let cancelled = false;
    previewWidget({ index, draft, types, notePaths, names })
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch(() => {
        // A failing widget comes back as a result; a rejection means the index
        // itself is gone, and a stale picture would be a lie.
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [draft, index, types]);
  return draft === null ? null : preview;
}
