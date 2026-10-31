import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyTypeEdit,
  noteTitle,
  type NoteMigration,
  type ObjectType,
  type TypeChange,
  type TypeEdit,
  type VaultPath,
} from '@dfai/domain';
import {
  countValuesThatWontFit,
  migrateNotes,
  notesToMigrate,
  saveObjectType,
  type DefinedType,
  type IndexPort,
  type MarkdownPort,
  type MigrationReport,
  type OpenNotes,
  type VaultFsPort,
} from '@dfai/application';
import type { TypeEditorNotice, TypeEditorPrompt } from '@dfai/ui';
import { localToday } from '../today.ts';
import type { ReadTypesAgain } from './use-types.ts';

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const notes = (count: number): string => (count === 1 ? '1 note' : `${count} notes`);

/** A sentence's words for one note or for several: "1 note uses it", "2 notes use them". */
const words = (count: number) =>
  count === 1
    ? { uses: 'uses', has: 'has', holds: 'holds', stores: 'stores', them: 'it', their: 'its' }
    : { uses: 'use', has: 'have', holds: 'hold', stores: 'store', them: 'them', their: 'their' };

const labelOf = (type: ObjectType, key: string): string =>
  type.properties.find((property) => property.key === key)?.label ?? key;

/** What a migration asks, in words: the question, and what "yes" and "no" are called. */
function migrationQuestion(migration: NoteMigration, before: ObjectType, count: number) {
  const say = words(count);
  switch (migration.kind) {
    case 'renameKey':
      return {
        text: `${notes(count)} ${say.stores} ${labelOf(before, migration.from)} as “${migration.from}”. Move ${say.their} value to “${migration.to}”?`,
        yes: `Rename and update ${notes(count)}`,
        no: 'Rename only',
      };
    case 'renameOption':
      return {
        text: `${notes(count)} ${say.uses} “${migration.from}”. Change ${say.them} to “${migration.to}”?`,
        yes: `Rename and update ${notes(count)}`,
        no: 'Rename only',
      };
    case 'removeKey':
      return {
        text: `${notes(count)} ${say.has} a value for ${labelOf(before, migration.key)}. Take it out of ${say.them} too?`,
        yes: `Remove from ${notes(count)}`,
        no: `Remove, keep ${say.their} value`,
      };
  }
}

/** Notes to bring along with a change, and how. */
type Migrate = { paths: VaultPath[]; migration: NoteMigration };

function reportNotice(report: MigrationReport): TypeEditorNotice {
  if (report.failed.length === 0) {
    return { tone: 'done', text: `Updated ${notes(report.migrated.length)}.` };
  }
  return {
    tone: 'problem',
    text: `Updated ${notes(report.migrated.length)}; ${notes(report.failed.length)} could not be updated.`,
    details: report.failed.map(({ path, reason }) => `${noteTitle(path)}: ${reason}`),
  };
}

/** How the person answered a question about the notes. */
type Answer = 'yes' | 'no' | 'cancel';

/**
 * The type editor's state and what its changes do.
 *
 * Each change is made by the domain (`applyTypeEdit`) and written to the type
 * file at once. One the notes could follow — a renamed key or option, a
 * removed key — is first counted against the notes, and when any would change
 * the person is asked; one that would leave values that no longer fit is
 * warned about.
 *
 * Changes are carried out one at a time, each against the type as the one
 * before it left it: a key renamed and then its kind changed a moment later
 * must end with both, not with whichever write landed last.
 */
export function useTypeEditor({
  fs,
  markdown,
  index,
  openNotes,
  type,
  types,
  onSaved,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  index: IndexPort;
  /** The panes, so a note one of them holds is migrated through it. */
  openNotes: Pick<OpenNotes, 'setPropertiesIfOpen'>;
  type: DefinedType | null;
  types: readonly DefinedType[];
  /** Asks for the types to be read again; settles with them once that read has landed. */
  onSaved: ReadTypesAgain;
}) {
  const [draft, setDraft] = useState<ObjectType | null>(type);
  const [prompt, setPrompt] = useState<TypeEditorPrompt | null>(null);
  const [notice, setNotice] = useState<TypeEditorNotice | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  /** The type as the last change left it, which the next change starts from. */
  const latest = useRef<ObjectType | null>(type);
  /**
   * Changes still being carried out, or written but not yet read back: while
   * there are any, a re-read may be stale — the types read before the last
   * write are still what is shown until the read it asked for lands (#456).
   */
  const pending = useRef(0);
  /** The file the editor is on: a re-read that lands for another is not this one's. */
  const shownPath = useRef(type?.path);
  /** Answers the open question with 'cancel', if one is open. */
  const cancelQuestion = useRef<(() => void) | null>(null);

  // What the file says replaces what the editor holds whenever it is re-read —
  // unless a change is still on its way, when the file may not show it yet.
  useEffect(() => {
    if (pending.current > 0) return;
    latest.current = type;
    setDraft(type);
  }, [type]);
  // Another type opened is another file: what was held for the last one never
  // carries over, even mid-change, and a question it left open is cancelled so
  // the changes queued behind it are not stuck waiting on an answer.
  useEffect(() => {
    shownPath.current = type?.path;
    latest.current = type;
    setDraft(type);
    setNotice(null);
    return () => cancelQuestion.current?.();
  }, [type?.path]);

  /** Puts a question up and waits for the answer. */
  const ask = useCallback(
    (question: { text: string; yes: string; no?: string }) =>
      new Promise<Answer>((resolve) => {
        const answer = (choice: Answer) => () => {
          cancelQuestion.current = null;
          setPrompt(null);
          resolve(choice);
        };
        cancelQuestion.current = answer('cancel');
        setPrompt({
          text: question.text,
          actions: [
            { label: question.yes, primary: true, run: answer('yes') },
            ...(question.no === undefined ? [] : [{ label: question.no, run: answer('no') }]),
            { label: 'Cancel', run: answer('cancel') },
          ],
        });
      }),
    [],
  );

  /** What to do about the notes: null to stop, else the migration to run, if any. */
  const plan = useCallback(
    async (
      before: ObjectType,
      change: TypeChange,
      request: TypeEdit,
    ): Promise<{ migrate: Migrate | null } | null> => {
      if (type === null) return null;
      const lookup = { fs, markdown, index, typeName: type.name };
      // A kind asked for, or one Allow many turned into (a select ↔ multi-select).
      const kindOf = (of: ObjectType, key: string) =>
        of.properties.find((p) => p.key === key)?.kind;
      if (
        request.kind === 'changeKind' ||
        (request.kind === 'setMany' &&
          kindOf(before, request.key) !== kindOf(change.type, request.key))
      ) {
        const def = change.type.properties.find((p) => p.key === request.key);
        const misfits = def === undefined ? 0 : await countValuesThatWontFit({ ...lookup, def });
        if (misfits === 0) return { migrate: null };
        const answer = await ask({
          text: `${notes(misfits)} ${words(misfits).holds} a value that won't fit. It is kept, and shown as a problem.`,
          yes: 'Change the kind',
        });
        return answer === 'yes' ? { migrate: null } : null;
      }
      const { migration } = change;
      if (migration === null) return { migrate: null };
      const paths = await notesToMigrate({ ...lookup, migration });
      if (paths.length === 0) return { migrate: null };
      const answer = await ask(migrationQuestion(migration, before, paths.length));
      if (answer === 'cancel') return null;
      return { migrate: answer === 'yes' ? { paths, migration } : null };
    },
    [type, fs, markdown, index, ask],
  );

  /**
   * One change's re-read is over. When it is the last one out, what it read is
   * shown: a re-read that landed while changes were pending was passed over,
   * and the next may be the same answer, which draws nothing new.
   */
  const readBack = useCallback(
    (path: VaultPath) => (fresh: readonly DefinedType[] | null) => {
      pending.current -= 1;
      if (pending.current > 0 || fresh === null || shownPath.current !== path) return;
      const now = fresh.find((each) => each.path === path);
      if (now === undefined || now === latest.current) return;
      latest.current = now;
      setDraft(now);
    },
    [],
  );

  /** One change, start to finish: made, asked about, written, and its notes brought along. */
  const carryOut = useCallback(
    async (request: TypeEdit) => {
      const before = latest.current;
      if (type === null || before === null) return;
      if (before.name !== type.name) {
        throw new Error(
          `That change was for ${type.label}, which is no longer open; it was not saved.`,
        );
      }
      const change = applyTypeEdit(before, request, { types: types.map((known) => known.name) });
      setNotice(null);
      const decided = await plan(before, change, request);
      if (decided === null) return;
      latest.current = change.type;
      setDraft(change.type);
      try {
        await saveObjectType({ fs, markdown, path: type.path, before, type: change.type });
        const { migrate } = decided;
        if (migrate !== null) {
          setNotice(
            reportNotice(
              await migrateNotes({ fs, markdown, openNotes, today: localToday(), ...migrate }),
            ),
          );
        }
      } catch (cause) {
        // Put back only what this change put there: another type may be open by now.
        if (latest.current === change.type) {
          latest.current = before;
          setDraft(before);
        }
        throw cause;
      } finally {
        pending.current += 1;
        // A read that fails is said where the types are (`useTypes`'s
        // failure); all this waits for is that it is over.
        onSaved().then(readBack(type.path), () => readBack(type.path)(null));
      }
    },
    [type, types, fs, markdown, openNotes, plan, onSaved, readBack],
  );

  const edit = useCallback(
    (request: TypeEdit) => {
      pending.current += 1;
      queue.current = queue.current
        .then(() => carryOut(request))
        .catch((cause: unknown) => setNotice({ tone: 'problem', text: message(cause) }))
        .finally(() => {
          pending.current -= 1;
        });
    },
    [carryOut],
  );

  return { draft, prompt, notice, edit };
}
