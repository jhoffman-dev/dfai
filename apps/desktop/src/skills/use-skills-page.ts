import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  characterCount,
  createVaultPath,
  MAX_SKILL_DESCRIPTION_LENGTH,
  skillDeletionWarning,
  skillDraftProblems,
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
import type { SkillEditorState, SkillsPageProps } from '@dfai/ui';
import { readAgain, vaultReadKey } from '../reads/query-client.ts';

/** The ports the skills' use-cases reach, and the question before a delete. */
export interface SkillsPagePorts {
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  /** Puts up and takes down the question before a delete, under the one-overlay rule. */
  readonly overlay: { show: () => void; hide: () => void };
}

/** Which skill the editor holds: a new one, one by name, or none. */
type Selection = { readonly kind: 'new' } | { readonly kind: 'skill'; readonly name: string };

/** What the editor started from and what has been typed over it. */
interface Editing {
  /** SKILL.md as read, which a save or a delete is held to; null for a new skill. */
  readonly base: SkillFile | null;
  readonly draft: SkillDraft;
  /** Whether SKILL.md changed on disk under typing not yet saved. */
  readonly changedOnDisk: boolean;
}

const EMPTY_DRAFT: SkillDraft = { name: '', description: '', instructions: '' };

const draftOf = (skill: SkillFile): SkillDraft => ({
  name: skill.name,
  description: skill.description,
  instructions: skill.instructions,
});

const sameDraft = (left: SkillDraft, right: SkillDraft) =>
  left.name === right.name &&
  left.description === right.description &&
  left.instructions === right.instructions;

/** Whether two reads of SKILL.md found the same file. */
const sameFile = (left: SkillFile, right: SkillFile) =>
  left.text === right.text &&
  left.modified === right.modified &&
  left.unreadable === right.unreadable;

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

/**
 * What the editor holds as the read of its skill arrives and changes: the
 * first read fills it, a change on disk is taken in while nothing is typed
 * over it, and otherwise is said, with Reload.
 */
function useFollowRead({
  opened,
  waiting,
  setEditing,
}: {
  opened: SkillFile | null | undefined;
  /** Whether the editor waits for its skill: a read already held fills it as well as a new one. */
  waiting: boolean;
  setEditing: (change: (was: Editing | null) => Editing | null) => void;
}) {
  useEffect(() => {
    // Still being read: the editor waits for it.
    if (opened === undefined) return;
    setEditing((was) => (was === null ? null : followed(was, opened)));
  }, [opened, waiting, setEditing]);
}

/** The editor after a read of its skill found `opened`: null when the skill is gone. */
function followed(was: Editing, opened: SkillFile | null): Editing | null {
  if (was.base === null) return opened === null ? null : fresh(opened);
  if (opened !== null && sameFile(was.base, opened)) return was;
  const clean = sameDraft(was.draft, draftOf(was.base));
  if (opened === null) return clean ? null : { ...was, changedOnDisk: true };
  return clean ? fresh(opened) : { ...was, changedOnDisk: true };
}

const fresh = (skill: SkillFile): Editing => ({
  base: skill,
  draft: draftOf(skill),
  changedOnDisk: false,
});

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

/** The editor's state as the page draws it: the draft, and the domain's words on it. */
function editorStateOf(editing: Editing, mode: 'new' | 'edit', saving: boolean): SkillEditorState {
  const readProblems = editing.base?.problems ?? [];
  return {
    mode,
    draft: editing.draft,
    problems: skillDraftProblems(editing.draft),
    // A description or instructions problem is said of the draft as it is typed.
    fileProblems: readProblems
      .filter(({ field }) => field === 'file' || field === 'name')
      .map(({ message }) => message),
    descriptionLength: characterCount(editing.draft.description),
    descriptionLimit: MAX_SKILL_DESCRIPTION_LENGTH,
    changedOnDisk: editing.changedOnDisk,
    saving,
  };
}

/** After a write: the skill as written is the one held, and the list is read again. */
function settle(client: QueryClient, vault: string, skill: SkillFile | null, name: string) {
  if (skill === null) client.removeQueries({ queryKey: skillKey(vault, name) });
  else client.setQueryData(skillKey(vault, skill.name), skill);
  void readAgain(client, vaultReadKey(vault, 'skills'));
}

/**
 * Everything the Skills page does (#169, ADR-0050): lists the skills and
 * the prompt notes, holds one skill in the editor, and saves, creates or
 * deletes it through the use-cases, saying what failed. The rules are the
 * domain's; the writes and their guards are the use-cases'.
 */
export function useSkillsPage({
  ports,
  vault,
  onOpenNote,
}: {
  ports: SkillsPagePorts;
  /** The open vault, whose reads these are; null while none is. */
  vault: string | null;
  onOpenNote: (path: VaultPath) => void;
}): Omit<SkillsPageProps, 'onShowSidebar' | 'history'> {
  const { fs, markdown, overlay } = ports;
  const client = useQueryClient();
  const lists = useSkillLists({ fs, markdown, vault });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
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

  const onSelect = useCallback((next: string) => {
    setNotice(null);
    setSelection({ kind: 'skill', name: next });
    setEditing({ base: null, draft: EMPTY_DRAFT, changedOnDisk: false });
  }, []);
  const onNew = useCallback(() => {
    setNotice(null);
    setSelection({ kind: 'new' });
    setEditing({ base: null, draft: EMPTY_DRAFT, changedOnDisk: false });
  }, []);
  const onClose = useCallback(() => {
    setSelection(null);
    setEditing(null);
  }, []);
  const onChange = useCallback(
    (change: Partial<SkillDraft>) =>
      setEditing((was) => (was === null ? was : { ...was, draft: { ...was.draft, ...change } })),
    [],
  );
  const latest = opened.data;
  const onReload = useCallback(() => {
    if (latest === null) onClose();
    else if (latest !== undefined) setEditing(fresh(latest));
    if (vault !== null && name !== null) void readAgain(client, skillKey(vault, name));
  }, [latest, onClose, vault, name, client]);

  const write = useCallback(
    async (work: () => Promise<SkillFile>) => {
      if (vault === null) return;
      setSaving(true);
      try {
        const written = await work();
        settle(client, vault, written, written.name);
        setNotice(null);
        setSelection({ kind: 'skill', name: written.name });
        setEditing(fresh(written));
      } catch (cause) {
        if (cause instanceof NoteChangedError) {
          // Read again: the read finds the change and the editor offers Reload.
          if (name !== null) void readAgain(client, skillKey(vault, name));
          setNotice('The skill was not saved: it changed on disk since it was opened.');
        } else setNotice(`The skill could not be saved: ${messageOf(cause)}`);
      } finally {
        setSaving(false);
      }
    },
    [vault, client, name],
  );
  const onSave = useCallback(() => {
    if (editing === null) return;
    const { base, draft } = editing;
    void write(() =>
      base === null
        ? createSkill({ fs, markdown, draft })
        : saveSkill({ fs, markdown, skill: base, draft }),
    );
  }, [editing, fs, markdown, write]);

  const base = editing?.base ?? null;
  const onDelete = useCallback(() => {
    if (base === null) return;
    skillOtherFiles({ fs, skill: base }).then(
      (others) => {
        setWarning(skillDeletionWarning(base.name, others));
        overlay.show();
      },
      (cause: unknown) => setNotice(`The skill could not be deleted: ${messageOf(cause)}`),
    );
  }, [base, fs, overlay]);
  const deleteQuestion = useMemo(() => {
    if (warning === null || base === null || vault === null) return null;
    const close = () => {
      overlay.hide();
      setWarning(null);
    };
    return {
      warning,
      onCancel: close,
      onConfirm: () => {
        close();
        deleteSkill({ fs, skill: base }).then(
          () => {
            settle(client, vault, null, base.name);
            setNotice(null);
            onClose();
          },
          (cause: unknown) => setNotice(`The skill could not be deleted: ${messageOf(cause)}`),
        );
      },
    };
  }, [warning, base, vault, overlay, fs, client, onClose]);

  return {
    ...lists,
    selected: name,
    editor:
      editing === null || (selection?.kind === 'skill' && editing.base === null)
        ? null
        : editorStateOf(editing, selection?.kind === 'new' ? 'new' : 'edit', saving),
    notice:
      notice ?? (opened.error ? `The skill could not be read: ${messageOf(opened.error)}` : null),
    deleteQuestion,
    onSelect,
    onNew,
    onChange,
    onSave,
    onDelete,
    onReload,
    onClose,
    onOpenPrompt: (path) => onOpenNote(createVaultPath(path)),
  };
}
