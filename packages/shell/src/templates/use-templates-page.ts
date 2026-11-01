import { useCallback, useMemo, useState } from 'react';
import {
  createVaultPath,
  templateNameOf,
  templateNameProblem,
  typeTemplateName,
  usesLost,
  type ObjectType,
  type TemplateUse,
  type VaultPath,
} from '@dfai/domain';
import {
  createTemplate,
  deleteTemplate,
  ensureTypeTemplate,
  moveTemplateToNotes,
  renameTemplate,
  type MarkdownPort,
  type NoteTemplate,
  type OpenEditorsPort,
  templateCatalogOf,
  type VaultFsPort,
} from '@dfai/application';
import type { TemplatesPageProps } from '@dfai/ui';
import type { TemplatesState } from '../types/use-templates.ts';

/** The ports the templates' use-cases reach: the files, and the panes that may show one. */
export interface TemplatePorts {
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  readonly editors: OpenEditorsPort;
  /** Closes the panes showing notes that are gone. */
  readonly closeNotes: (paths: readonly VaultPath[]) => void;
  /** Puts up and takes down the question before a delete or a move, under the one-overlay rule. */
  readonly overlay: {
    show: (overlay: TemplateOverlay) => void;
    hide: (overlay: TemplateOverlay) => void;
  };
}

/** The questions asked about a template: before it goes to the Trash, and before it becomes a note. */
export type TemplateOverlay = 'template-delete' | 'template-to-note';

type TemplateAction = 'delete' | 'to-note';

const OVERLAY_OF: Readonly<Record<TemplateAction, TemplateOverlay>> = {
  delete: 'template-delete',
  'to-note': 'template-to-note',
};

/** The question before a template is trashed or made a note, while it is being asked. */
export interface TemplateQuestion {
  readonly action: TemplateAction;
  /** "Person template" before a delete; the template's own name, which the note keeps, before a move. */
  readonly name: string;
  /** What stops being made from the template once it is gone. */
  readonly lost: readonly TemplateUse[];
  readonly unsaved: boolean;
  readonly confirm: () => void;
  readonly close: () => void;
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * The template at `path`, as listed — or as its path names it, when it was
 * made a moment ago and the list has not been read again. The use-case still
 * refuses anything that is not a template.
 */
function templateAt(listed: readonly NoteTemplate[] | undefined, path: string): NoteTemplate {
  const at = createVaultPath(path);
  return listed?.find((template) => template.path === at) ?? { path: at, name: templateNameOf(at) };
}

/**
 * Everything the app does with templates: the Templates page's list and its
 * commands, "Edit template" from a type, and the question before a delete.
 * Each command is a use-case's; this only carries it out and says what failed.
 */
export function useTemplatesPage({
  ports,
  types,
  listed,
  onChanged,
  onOpen,
}: {
  ports: TemplatePorts;
  types: readonly ObjectType[];
  /** The templates folder as the window lists it (`useTemplates`). */
  listed: TemplatesState;
  /** Re-reads the vault after a template was written, moved or trashed. */
  onChanged: () => void;
  /** Opens a template in a pane, to be edited. */
  onOpen: (path: VaultPath) => void;
}) {
  const { fs, markdown, editors, closeNotes, overlay } = ports;
  const catalog = useMemo(
    () =>
      listed.kind === 'ready' ? templateCatalogOf({ templates: listed.templates, types }) : null,
    [listed, types],
  );
  const error = listed.kind === 'failed' ? listed.message : null;
  const [notice, setNotice] = useState<string | null>(null);
  const [asked, setAsked] = useState<{
    action: TemplateAction;
    path: VaultPath;
    name: string;
  } | null>(null);

  /** Runs a command, and says why when it fails rather than letting it vanish. */
  const run = useCallback(
    (work: Promise<unknown>) =>
      work.then(
        () => {
          setNotice(null);
          onChanged();
        },
        (cause: unknown) => setNotice(`The template could not be changed: ${messageOf(cause)}`),
      ),
    [onChanged],
  );

  const editTypeTemplate = useCallback(
    (typeName: string) => {
      const type = types.find((candidate) => candidate.name === typeName);
      if (type === undefined) return;
      void run(ensureTypeTemplate({ fs, markdown, type }).then(({ path }) => onOpen(path)));
    },
    [fs, markdown, types, run, onOpen],
  );

  const templates = catalog?.templates;
  const create = useCallback(
    ({ name, typeName }: { name: string; typeName: string | null }) => {
      const type = types.find((candidate) => candidate.name === typeName) ?? null;
      const made = createTemplate({ fs, markdown, name, type, templates: templates ?? [] });
      void run(made.then(onOpen));
    },
    [fs, markdown, types, templates, run, onOpen],
  );

  const rename = useCallback(
    ({ path, name }: { path: string; name: string }) => {
      const template = templateAt(templates, path);
      void run(renameTemplate({ fs, editors, template, name, templates: templates ?? [] }));
    },
    [fs, editors, templates, run],
  );

  const ask = useCallback(
    (action: TemplateAction, path: string) => {
      const template = templateAt(templates, path);
      setAsked({ action, path: template.path, name: template.name });
      overlay.show(OVERLAY_OF[action]);
    },
    [templates, overlay],
  );
  const askDelete = useCallback((path: string) => ask('delete', path), [ask]);
  const askMoveToNotes = useCallback((path: string) => ask('to-note', path), [ask]);

  const question = useMemo<TemplateQuestion | null>(() => {
    if (asked === null) return null;
    const { action, path, name } = asked;
    const close = () => {
      overlay.hide(OVERLAY_OF[action]);
      setAsked(null);
    };
    const work = () =>
      action === 'delete'
        ? deleteTemplate({ fs, editors, path }).then(() => closeNotes([path]))
        : moveTemplateToNotes({ fs, editors, path }).then(onOpen);
    return {
      action,
      name: action === 'delete' ? `${name} template` : name,
      lost: usesLost({ from: name, to: null, types }),
      unsaved: editors.state(path) === 'dirty',
      close,
      confirm: () => {
        close();
        void run(work());
      },
    };
  }, [asked, fs, editors, closeNotes, overlay, run, onOpen, types]);

  const takenPaths = useMemo(() => (templates ?? []).map(({ path }) => path), [templates]);
  const page = useMemo<Omit<TemplatesPageProps, 'onShowSidebar' | 'history'>>(
    () => ({
      catalog:
        catalog === null
          ? null
          : {
              templates: catalog.templates,
              typesWithout: catalog.typesWithout.map((type) => ({
                name: type.name,
                label: type.label,
                templateName: typeTemplateName(type),
              })),
            },
      error,
      nameProblem: (name, except) => templateNameProblem({ name, takenPaths, except }),
      onOpen: (path) => onOpen(createVaultPath(path)),
      onCreate: create,
      onRename: rename,
      onDelete: askDelete,
      onMoveToNotes: askMoveToNotes,
      usesLost: (path, name) =>
        usesLost({ from: templateNameOf(createVaultPath(path)), to: name, types }),
    }),
    [catalog, error, takenPaths, onOpen, create, rename, askDelete, askMoveToNotes, types],
  );

  return { page, question, notice, editTypeTemplate, askDelete, askMoveToNotes };
}
