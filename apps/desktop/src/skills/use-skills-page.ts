import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  createVaultPath,
  skillDeletionWarning,
  skillInUseWarning,
  skillUsers,
  type SkillDraft,
  type SkillUser,
  type VaultPath,
} from '@dfai/domain';
import {
  createSkill,
  deleteSkill,
  isChangedOnDiskRefusal,
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
  rules,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  vault: string | null;
  rules: readonly SkillUser[];
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
        (list) => {
          // A rule is the user of the folder its run would read, of those there are.
          const folders = list.map((skill) => skill.name);
          return list.map(({ name, description, problems }) => {
            const usedBy = skillUsers(rules, name, folders);
            return {
              name,
              description,
              problems: problems.map(({ message }) => message),
              ...(usedBy.length > 0 && { usedBy }),
            };
          });
        },
      ),
      prompts: listedOf(
        { data: promptsRead, error: promptsError },
        'The prompt notes could not be read',
        (list) => list,
      ),
    }),
    [skillsRead, skillsError, promptsRead, promptsError, rules],
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
 * Keeps an overlay's life to its question's: the moment the question is gone,
 * for whatever reason — answered, its skill gone from disk, its page moved
 * on — the overlay is taken down, so the window is never held by a question
 * nobody can see or answer.
 */
function useOverlayFollows({
  overlay,
  which,
  up,
  asked,
}: {
  overlay: SkillsPagePorts['overlay'];
  which: SkillOverlay;
  up: SkillOverlay | null;
  asked: boolean;
}) {
  useEffect(() => {
    if (!asked && up === which) overlay.hide(which);
  }, [asked, up, which, overlay]);
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
  setFocusTarget,
}: {
  editing: Editing | null;
  setEditing: (editing: Editing | null) => void;
  overlay: SkillsPagePorts['overlay'];
  overlayUp: SkillOverlay | null;
  setNotice: (notice: string | null) => void;
  setFocusTarget: (focus: SkillFocus) => void;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [leaving, setLeaving] = useState<{ readonly to: Selection | null } | null>(null);
  const generation = useRef(0);
  // The same count, drawn: what an editor's own state, such as an ask of Claude, belongs to.
  const [opening, setOpening] = useState(0);
  const choose = useCallback(
    (to: Selection | null, editingTo: Editing | null = to === null ? null : EMPTY_EDITING) => {
      generation.current += 1;
      setOpening((was) => was + 1);
      setNotice(null);
      setSelection(to);
      setEditing(editingTo);
    },
    [setEditing, setNotice],
  );
  /** Goes to `to`; closing the editor from inside it sends the focus to the skill's row, or the list. */
  const go = useCallback(
    (to: Selection | null) => {
      if (to === null && selection !== null) {
        setFocusTarget(
          selection.kind === 'skill' ? { kind: 'row', name: selection.name } : { kind: 'list' },
        );
      }
      choose(to);
    },
    [selection, choose, setFocusTarget],
  );
  const leaveFor = useCallback(
    (to: Selection | null) => {
      if (to?.kind === 'skill' && selection?.kind === 'skill' && to.name === selection.name) return;
      if (!isDirty(editing)) return go(to);
      setLeaving({ to });
      overlay.show('skill-discard');
    },
    [selection, editing, go, overlay],
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
        go(leaving.to);
      },
    };
  }, [leaving, overlayUp, overlay, editing, go]);
  return { selection, choose, leaveFor, discardQuestion, generation, opening };
}

/** What the Skills page is handed, and which editor it shows: each skill or new one opened is counted. */
export type SkillsPageState = Omit<SkillsPageProps, 'onShowSidebar' | 'history'> & {
  readonly opening: number;
};

/**
 * Everything the Skills page does (#169, ADR-0050): lists the skills and
 * the prompt notes, holds one skill in the editor, and saves, creates or
 * deletes it through the use-cases, saying what failed. The rules are the
 * domain's; the writes and their guards are the use-cases'.
 */
export function useSkillsPage({
  ports,
  rules,
  overlayUp,
  vault,
  onOpenNote,
}: {
  ports: SkillsPagePorts;
  /** The vault's automations: which use each skill (#169). */
  rules: readonly SkillUser[];
  /** Which of this page's questions the window's overlay store holds up, if either. */
  overlayUp: SkillOverlay | null;
  /** The open vault, whose reads these are; null while none is. */
  vault: string | null;
  onOpenNote: (path: VaultPath) => void;
}): SkillsPageState {
  const { fs, markdown, overlay } = ports;
  const client = useQueryClient();
  const lists = useSkillLists({ fs, markdown, vault, rules });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<SkillFocus | null>(null);
  const picked = useSelection({
    editing,
    setEditing,
    overlay,
    overlayUp,
    setNotice,
    setFocusTarget,
  });
  const { selection, choose, leaveFor, generation } = picked;
  const name = selection?.kind === 'skill' ? selection.name : null;
  const opened = useQuery({
    queryKey: skillKey(vault ?? '', name ?? ''),
    queryFn: async () => (await readSkill({ fs, markdown, name: name ?? '' })) ?? null,
    enabled: vault !== null && name !== null,
  });
  const waiting = name !== null && editing?.base === null;
  useFollowRead({
    // Opening a skill waits for a read under way: one held from before may say it is gone.
    opened: waiting && opened.isFetching ? undefined : opened.data,
    waiting,
    setEditing,
  });
  // The open skill gone from disk, its editor closed: nothing is chosen, so a click opens it again.
  const gone = name !== null && editing === null;
  useEffect(() => {
    if (!gone) return;
    setFocusTarget({ kind: 'list' });
    choose(null);
  }, [gone, choose]);

  const onChange = useCallback(
    (change: Partial<SkillDraft>) =>
      setEditing((was) => (was === null ? was : { ...was, draft: { ...was.draft, ...change } })),
    [],
  );
  const latest = opened.data;
  const onReload = useCallback(() => {
    if (latest === null) {
      setFocusTarget({ kind: 'list' });
      choose(null);
    } else if (latest !== undefined) setEditing(fresh(latest));
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
    rules,
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
    opening: picked.opening,
    editor:
      editing === null || (selection?.kind === 'skill' && editing.base === null)
        ? null
        : editorStateOf({
            editing,
            mode: selection?.kind === 'new' ? 'new' : 'edit',
            saving,
            deleting: deleting.busy,
          }),
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
          // Refused by the use-case's re-read, or by the host's own check at the write.
          if (!(cause instanceof NoteChangedError) && !isChangedOnDiskRefusal(cause)) {
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
 * — drawn only while the window holds the question up, and the question taken
 * down the moment its skill is no longer the one open — and on yes puts the
 * folder in the Trash. One delete at a time: Delete is off from the walk to
 * the Trash's answer. An answer for a page gone, or a skill no longer chosen,
 * changes nothing on the page.
 */
function useDeleteSkill({
  fs,
  client,
  vault,
  base,
  names,
  rules,
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
  rules: readonly SkillUser[];
  overlay: SkillsPagePorts['overlay'];
  overlayUp: SkillOverlay | null;
  generation: { readonly current: number };
  choose: (to: Selection | null) => void;
  setNotice: (notice: string | null) => void;
  setFocusTarget: (focus: SkillFocus | null) => void;
}) {
  /** The question's words, while it is asked: it stands only while a skill is open to delete. */
  const [asked, setAsked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useMounted();
  const standing = asked !== null && base !== null && vault !== null;
  useOverlayFollows({ overlay, which: 'skill-delete', up: overlayUp, asked: standing });
  useEffect(() => {
    if (asked !== null && !standing) setAsked(null);
  }, [asked, standing]);
  const failed = useCallback(
    (cause: unknown) => {
      if (mounted.current) setNotice(`The skill could not be deleted: ${messageOf(cause)}`);
    },
    [mounted, setNotice],
  );
  const ask = useCallback(() => {
    if (base === null || busy) return;
    const chosen = generation.current;
    setBusy(true);
    skillOtherFiles({ fs, skill: base })
      .then((others) => {
        if (!mounted.current || generation.current !== chosen) return;
        const inUse = skillInUseWarning(skillUsers(rules, base.name, names));
        const warning = skillDeletionWarning(base.name, others);
        setAsked(inUse === null ? warning : `${warning} ${inUse}`);
        overlay.show('skill-delete');
      }, failed)
      .finally(() => setBusy(false));
  }, [base, busy, generation, fs, mounted, overlay, failed, rules]);
  const question = useMemo(() => {
    if (!standing || asked === null || base === null || vault === null) return null;
    if (overlayUp !== 'skill-delete') return null;
    const close = () => {
      overlay.hide('skill-delete');
      setAsked(null);
    };
    const confirm = () => {
      close();
      const chosen = generation.current;
      setBusy(true);
      deleteSkill({ fs, skill: base })
        .then(() => {
          settle(client, vault, null, base.name);
          // Another skill, or New, was opened while the Trash ran: its editor is left as it is.
          if (!mounted.current || generation.current !== chosen) return;
          setFocusTarget(focusAfterDelete(names, base.name));
          choose(null);
        }, failed)
        .finally(() => setBusy(false));
    };
    return { warning: asked, onCancel: close, onConfirm: confirm };
  }, [
    standing,
    asked,
    base,
    vault,
    overlayUp,
    overlay,
    generation,
    fs,
    client,
    mounted,
    names,
    choose,
    failed,
    setFocusTarget,
  ]);
  return { ask, question, busy };
}
