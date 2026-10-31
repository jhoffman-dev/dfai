import {
  createVaultPath,
  objectTypeIcon,
  pageCrumb,
  type ObjectType,
  type VaultPath,
  type ViewTab,
} from '@dfai/domain';
import type {
  DefinedType,
  IndexPort,
  MarkdownPort,
  OpenNotes,
  VaultFsPort,
} from '@dfai/application';
import {
  EditableTitle,
  PageAction,
  PageBar,
  PageHead,
  SelectionBar,
  TableView,
  ViewTabs,
  type PageHistory,
  type ViewTabEditing,
  type OpenHow,
  type PeekRequest,
} from '@dfai/ui';
import { PageFrameFallback } from '../page-frame-fallback.tsx';
import { schemaOf } from '../panes/table-schema.ts';
import type { useTypeTable } from './use-type-table.ts';
import { useTypeEditor } from './use-type-editor.ts';
import type { ChosenRows } from '../people/use-chosen-people.ts';
import type { ReadTypesAgain } from './use-types.ts';

/**
 * A type's own page: its name, renamed in place, and — for a type with no
 * views — its default table under the one tab it has (ADR-0023). A type with
 * views opens on one of them instead; reached by Back, this page lists them.
 * The type itself is edited in the right sidebar's Type tab (slice 12), which
 * "Edit type" shows and hides.
 */
export function TypePage({
  table,
  types,
  editing,
  onEditTypeStart,
  onEditType,
  ports,
  onSaved,
  onOpenNote,
  onPeek,
  onNewNote,
  tabs,
  tabEditing,
  onOpenView,
  onEditTemplate,
  onFindDuplicates,
  choosing,
  onRowFocus,
  onShowSidebar,
  history,
}: {
  table: ReturnType<typeof useTypeTable>;
  types: readonly DefinedType[];
  /** Whether the type's editor is on screen in the right sidebar. */
  editing: boolean;
  /** The pointer coming down on Edit type, before the press moves the focus. */
  onEditTypeStart?: () => void;
  /** Shows the type's editor in the right sidebar, or hides it when it is shown. */
  onEditType: () => void;
  ports: {
    fs: VaultFsPort;
    markdown: MarkdownPort;
    index: IndexPort;
    openNotes: Pick<OpenNotes, 'setPropertiesIfOpen'>;
  };
  onSaved: ReadTypesAgain;
  /** Opens a row's note; `how` is where the click asked for it, when it said. */
  onOpenNote: (path: VaultPath, how?: OpenHow) => void;
  /** Given, a row's name clicked plainly peeks its note, in the list the header names (slice 6b). */
  onPeek?: (request: PeekRequest, within: string) => void;
  /** Makes a note of this type, from the foot of its table. */
  onNewNote: (type: ObjectType) => void;
  /** The type's tabs: its views, or its default table while it has none. */
  tabs: readonly ViewTab[];
  /** What the tabs can do: add a view, rename or copy the default table. */
  tabEditing: ViewTabEditing | undefined;
  onOpenView: (path: VaultPath) => void;
  /** Opens the template the type's new notes start as, made if it has none. */
  onEditTemplate: (type: ObjectType) => void;
  /** Given on the Person type's page: opens the list of people who may be one (#464). */
  onFindDuplicates?: () => void;
  /** Given on the Person type's page: rows chosen, and what can be done to them — Merge into… */
  choosing?: ChosenRows;
  /** Told the row the table's focus landed in, for the right sidebar. */
  onRowFocus?: (path: string) => void;
  onShowSidebar?: () => void;
  history?: PageHistory;
}) {
  const defined = types.find((candidate) => candidate.name === table.type?.name) ?? null;
  const editor = useTypeEditor({ ...ports, type: defined, types, onSaved });
  const type = editor.draft ?? table.type;
  // A type that is gone — deleted under its page — keeps the page's frame: Back still leads out.
  if (type === null) {
    return (
      <PageFrameFallback
        {...(onShowSidebar !== undefined && { onShowSidebar })}
        {...(history !== undefined && { history })}
      />
    );
  }
  const page = { kind: 'type', typeName: type.name } as const;

  return (
    <>
      <PageBar
        crumb={{ ...pageCrumb(page, null), icon: objectTypeIcon(type) }}
        name={type.label}
        actions={
          <>
            {onFindDuplicates !== undefined && (
              <PageAction
                icon="person"
                label="Possible duplicates"
                tone="secondary"
                onPress={onFindDuplicates}
              />
            )}
            <PageAction
              icon="template"
              label="Edit template"
              tone="secondary"
              onPress={() => onEditTemplate(type)}
            />
            <PageAction
              icon="panel"
              label="Edit type"
              title="Edit type in the right sidebar"
              tone="secondary"
              pressed={editing}
              {...(onEditTypeStart !== undefined && { onPressStart: onEditTypeStart })}
              onPress={onEditType}
            />
          </>
        }
        {...(onShowSidebar !== undefined && { onShowSidebar })}
        {...(history !== undefined && { history })}
      />
      <div className="panel__body">
        <article className="page page--wide" aria-label={type.label}>
          <PageHead
            title={
              <EditableTitle
                value={type.label}
                label="Type name"
                hint="Rename this type"
                onCommit={(label) => editor.edit({ kind: 'setLabel', label })}
              />
            }
          />
          <div className="view-toolbar">
            <ViewTabs
              tabs={tabs}
              onOpenView={(path) => onOpenView(createVaultPath(path))}
              // The page's own controls already open the type and its template.
              editing={
                tabEditing && {
                  ...tabEditing,
                  onEditType: undefined,
                  onEditTemplate: undefined,
                }
              }
            />
          </div>
          {choosing !== undefined && choosing.count > 0 && (
            <SelectionBar
              count={choosing.count}
              actions={choosing.actions}
              onClear={choosing.clear}
            />
          )}
          <TableView
            result={table.result}
            sorts={table.sorts}
            error={table.error}
            schema={schemaOf(table.type, type.name)}
            onOpenNote={(path, how) => onOpenNote(createVaultPath(path), how)}
            {...(onPeek !== undefined && {
              onPeek: (request: PeekRequest) => onPeek(request, `${type.label} table`),
            })}
            onEditCell={table.editCell}
            onToggleSort={table.toggleSort}
            onNewNote={() => onNewNote(type)}
            {...(choosing !== undefined && { selection: choosing.selection })}
            {...(onRowFocus !== undefined && { onRowFocus })}
          />
        </article>
      </div>
    </>
  );
}
