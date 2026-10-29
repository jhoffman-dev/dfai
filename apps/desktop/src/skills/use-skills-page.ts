import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  createVaultPath,
  skillDeletionWarning,
  type SkillDraft,
  type VaultPath,
} from '@dfai/domain';
import {
  createSkill,
  deleteSkill,
  listPromptNotes,
  listSkills,
  NoteChangedError,
  readSkill,
  saveSkill,
  skillOtherFiles,
  type MarkdownPort,
  type SkillFile,
  type VaultFsPort,
} from '@dfai/application';
import type { SkillFocus, SkillsPageProps } from '@dfai/ui';
import { readAgain, vaultReadKey } from '../reads/query-client.ts';
import {
  EMPTY_EDITING,
  editorStateOf,
  focusAfterDelete,
  followed,
  fresh,
  isDirty,
  type Editing,
  type Selection,
} from './skill-editing.ts';

/** The window's overlays this page asks for: before a delete, and before typing is thrown away. */
export type SkillOverlay = 'skill-delete' | 'skill-discard';

/** The ports the skills' use-cases reach, and the window's overlays. */
export interface SkillsPagePorts {
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  /** Puts up and takes down a question, under the one-overlay rule. */
  readonly overlay: { show: (which: SkillOverlay) => void; hide: (which: SkillOverlay) => void };
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The read of one skill, under the skills' own read so a change in the folder reads it again. */
const skillKey = (vault: string, name: string) =>
  [...vaultReadKey(vault, 'skills'), 'skill', name] as const;

/** A read's state as the page's lists show it. */
function listedOf<T, Item>(
  query: { data: T | undefined; error: unknown },
  failure: string,
  items: (data: T) => readonly Item[],
) {
  if (query.error !== null && query.error !== undefined) {
    return { items: null, error: `${failure}: ${messageOf(query.error)}` };
  }
  return { items: query.data === undefined ? null : items(query.data), error: null };
}

/** The skills and the prompt notes, each read only while the page is open. */
function useSkillLists({
  fs,
  markdown,
  vault,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  vault: string | null;
}) {
  const skills = useQuery({
    queryKey: vaultReadKey(vault ?? '', 'skills'),
    queryFn: () => listSkills({ fs, markdown }),
    enabled: vault !== null,
  });
  const prompts = useQuery({
    queryKey: vaultReadKey(vault ?? '', 'prompts'),
    queryFn: () => listPromptNotes(fs),
    enabled: vault !== null,
  });
  const { data: skillsRead, error: skillsError } = skills;
  const { data: promptsRead, error: promptsError } = prompts;
  return useMemo(
    () => ({
      skills: listedOf(
        { data: skillsRead, error: skillsError },
        'The skills could not be read',
        (list) =>
          list.map(({ name, description, problems }) => ({
            name,
            description,
            problems: problems.map(({ message }) => message),
          })),
      ),
      prompts: listedOf(
        { data: promptsRead, error: promptsError },
        'The prompt notes could not be read',
        (list) => list,
      ),
    }),
    [skillsRead, skillsError, promptsRead, promptsError],
  );
}

/** After a write: the skill as written is the one held, and the list is read again. */
function settle(client: QueryClient, vault: string, skill: SkillFile | null, name: string) {
  if (skill === null) client.removeQueries({ queryKey: skillKey(vault, name) });
  else client.setQueryData(skillKey(vault, skill.name), skill);
  void readAgain(client, vaultReadKey(vault, 'skills'));
}

/**
 * Fills and follows the editor as the read of its skill arrives and changes
 * (`followed`). `waiting` reruns it when the editor waits on a read already
 * held, as when the same skill is opened again.
 */
function useFollowRead({
  opened,
  waiting,
  setEditing,
}: {
  opened: SkillFile | null | undefined;
  waiting: boolean;
  setEditing: (change: (was: Editing | null) => Editing | null) => void;
}) {
  useEffect(() => {
    // Still being read: the editor waits for it.
    if (opened === undefined) return;
    setEditing((was) => (was === null ? null : followed(was, opened)));
  }, [opened, waiting, setEditing]);
}

/** Whether the component is still mounted: an answer arriving after it has gone does nothing. */
function useMounted() {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

/**
 * Which skill the editor holds, and leaving it: choosing the open skill again
 * does nothing, and leaving typing unsaved asks first (Keep or Discard).
 * `generation` counts each choice, so a write that answers after another was
 * made knows it is no longer the one shown.
 */
function useSelection({
  editing,
  setEditing,
  overlay,
  overlayUp,
  setNotice,
}: {
  editing: Editing | null;
  setEditing: (editing: Editing | null) => void;
  overlay: SkillsPagePorts['overlay'];
  overlayUp: SkillOverlay | null;
  setNotice: (notice: string | null) => void;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [leaving, setLeaving] = useState<{ readonly to: Selection | null } | null>(null);
  const generation = useRef(0);
  const choose = useCallback(
    (to: Selection | null, editingTo: Editing | null = to === null ? null : EMPTY_EDITING) => {
      generation.current += 1;
      setNotice(null);
      setSelection(to);
      setEditing(editingTo);
    },
    [setEditing, setNotice],
  );
  const leaveFor = useCallback(
    (to: Selection | null) => {
      if (to?.kind === 'skill' && selection?.kind === 'skill' && to.name === selection.name) return;
      if (!isDirty(editing)) return choose(to);
      setLeaving({ to });
      overlay.show('skill-discard');
    },
    [selection, editing, choose, overlay],
  );
  const discardQuestion = useMemo(() => {
    if (leaving === null || overlayUp !== 'skill-discard') return null;
    const close = () => {
      overlay.hide('skill-discard');
      setLeaving(null);
    };
    return {
      name: editing?.base?.name ?? null,
      onKeep: close,
      onDiscard: () => {
        close();
        choose(leaving.to);
      },
    };
  }, [leaving, overlayUp, overlay, editing, choose]);
  return { selection, choose, leaveFor, discardQuestion, generation };
}

/**
 * Everything the Skills page does (#169, ADR-0050): lists the skills and
 * the prompt notes, holds one skill in the editor, and saves, creates or
 * deletes it through the use-cases, saying what failed. The rules are the
 * domain's; the writes and their guards are the use-cases'.
 */
export function useSkillsPage({
  ports,
  overlayUp,
  vault,
  onOpenNote,
}: {
  ports: SkillsPagePorts;
  /** Which of this page's questions the window's overlay store holds up, if either. */
  overlayUp: SkillOverlay | null;
  /** The open vault, whose reads these are; null while none is. */
  vault: string | null;
  onOpenNote: (path: VaultPath) => void;
}): Omit<SkillsPageProps, 'onShowSidebar' | 'history'> {
  const { fs, markdown, overlay } = ports;
  const client = useQueryClient();
  const lists = useSkillLists({ fs, markdown, vault });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<SkillFocus | null>(null);
  const picked = useSelection({ editing, setEditing, overlay, overlayUp, setNotice });
  const { selection, choose, leaveFor, generation } = picked;
  const name = selection?.kind === 'skill' ? selection.name : null;
  const opened = useQuery({
    queryKey: skillKey(vault ?? '', name ?? ''),
    queryFn: async () => (await readSkill({ fs, markdown, name: name ?? '' })) ?? null,
    enabled: vault !== null && name !== null,
  });
  useFollowRead({
    opened: opened.data,
    waiting: name !== null && editing?.base === null,
    setEditing,
  });

  const onChange = useCallback(
    (change: Partial<SkillDraft>) =>
      setEditing((was) => (was === null ? was : { ...was, draft: { ...was.draft, ...change } })),
    [],
  );
  const latest = opened.data;
  const onReload = useCallback(() => {
    if (latest === null) choose(null);
    else if (latest !== undefined) setEditing(fresh(latest));
    if (vault !== null && name !== null) void readAgain(client, skillKey(vault, name));
  }, [latest, choose, vault, name, client]);
  const onSave = useSaveSkill({
    fs,
    markdown,
    client,
    vault,
    editing,
    name,
    generation,
    choose,
    setSaving,
    setNotice,
  });
  const deleting = useDeleteSkill({
    fs,
    client,
    vault,
    base: editing?.base ?? null,
    names: (lists.skills.items ?? []).map((skill) => skill.name),
    overlay,
    overlayUp,
    generation,
    choose,
    setNotice,
    setFocusTarget,
  });

  return {
    ...lists,
    selected: name,
    editor:
      editing === null || (selection?.kind === 'skill' && editing.base === null)
        ? null
        : editorStateOf({ editing, mode: selection?.kind === 'new' ? 'new' : 'edit', saving }),
    notice:
      notice ?? (opened.error ? `The skill could not be read: ${messageOf(opened.error)}` : null),
    deleteQuestion: deleting.question,
    discardQuestion: picked.discardQuestion,
    focusTarget,
    onFocused: () => setFocusTarget(null),
    onSelect: (next) => leaveFor({ kind: 'skill', name: next }),
    onNew: () => leaveFor({ kind: 'new' }),
    onClose: () => leaveFor(null),
    onChange,
    onSave,
    onDelete: deleting.ask,
    onReload,
    onOpenPrompt: (path) => onOpenNote(createVaultPath(path)),
  };
}

/**
 * Save: creates the new skill or saves the open one. Its answer is shown
 * only while the skill it was made for is still the one chosen; a file
 * changed on disk is read again, which offers Reload.
 */
function useSaveSkill({
  fs,
  markdown,
  client,
  vault,
  editing,
  name,
  generation,
  choose,
  setSaving,
  setNotice,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  client: QueryClient;
  vault: string | null;
  editing: Editing | null;
  name: string | null;
  generation: { readonly current: number };
  choose: (to: Selection | null, editing?: Editing | null) => void;
  setSaving: (saving: boolean) => void;
  setNotice: (notice: string | null) => void;
}) {
  return useCallback(() => {
    if (editing === null || vault === null) return;
    const { base, draft } = editing;
    const chosen = generation.current;
    setSaving(true);
    const work =
      base === null
        ? createSkill({ fs, markdown, draft })
        : saveSkill({ fs, markdown, skill: base, draft });
    work
      .then(
        (written) => {
          settle(client, vault, written, written.name);
          if (generation.current !== chosen) return;
          choose({ kind: 'skill', name: written.name }, fresh(written, base === null));
        },
        (cause: unknown) => {
          if (generation.current !== chosen) return;
          if (!(cause instanceof NoteChangedError)) {
            setNotice(`The skill could not be saved: ${messageOf(cause)}`);
            return;
          }
          // Read again: the read finds the change and the editor offers Reload.
          if (name !== null) void readAgain(client, skillKey(vault, name));
          setNotice('The skill was not saved: it changed on disk since it was opened.');
        },
      )
      .finally(() => setSaving(false));
  }, [editing, vault, generation, fs, markdown, client, choose, name, setSaving, setNotice]);
}

/**
 * Delete: walks the folder for what goes with it, asks in the domain's words
 * — drawn only while the window holds the question up — and on yes puts the
 * folder in the Trash and sends the focus on. An answer for a page gone, or
 * a skill no longer chosen, puts nothing up.
 */
function useDeleteSkill({
  fs,
  client,
  vault,
  base,
  names,
  overlay,
  overlayUp,
  generation,
  choose,
  setNotice,
  setFocusTarget,
}: {
  fs: VaultFsPort;
  client: QueryClient;
  vault: string | null;
  base: SkillFile | null;
  names: readonly string[];
  overlay: SkillsPagePorts['overlay'];
  overlayUp: SkillOverlay | null;
  generation: { readonly current: number };
  choose: (to: Selection | null) => void;
  setNotice: (notice: string | null) => void;
  setFocusTarget: (focus: SkillFocus | null) => void;
}) {
  const [warning, setWarning] = useState<string | null>(null);
  const mounted = useMounted();
  const failed = useCallback(
    (cause: unknown) => setNotice(`The skill could not be deleted: ${messageOf(cause)}`),
    [setNotice],
  );
  const ask = useCallback(() => {
    if (base === null) return;
    const chosen = generation.current;
    skillOtherFiles({ fs, skill: base }).then((others) => {
      if (!mounted.current || generation.current !== chosen) return;
      setWarning(skillDeletionWarning(base.name, others));
      overlay.show('skill-delete');
    }, failed);
  }, [base, generation, fs, mounted, overlay, failed]);
  const question = useMemo(() => {
    if (warning === null || base === null || vault === null || overlayUp !== 'skill-delete') {
      return null;
    }
    const close = () => {
      overlay.hide('skill-delete');
      setWarning(null);
    };
    return {
      warning,
      onCancel: close,
      onConfirm: () => {
        close();
        deleteSkill({ fs, skill: base }).then(() => {
          settle(client, vault, null, base.name);
          setFocusTarget(focusAfterDelete(names, base.name));
          choose(null);
        }, failed);
      },
    };
  }, [warning, base, vault, overlayUp, overlay, fs, client, names, choose, failed, setFocusTarget]);
  return { ask, question };
}
