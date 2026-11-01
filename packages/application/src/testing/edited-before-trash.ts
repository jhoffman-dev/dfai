import { EntryChangedError, type VaultFsPort } from '../vault/ports.ts';

type TrashingFs = Pick<VaultFsPort, 'readTextFile' | 'trashEntry'>;

/**
 * `fs` with an edit landing just before its first trash — the moment between a
 * caller's check and its trash — and a Trash that keeps the host's "unless
 * changed" hold (#235): each file named in `unchanged` must still hold the
 * modification time and the text it was read with, or nothing moves.
 */
export function editedBeforeTrash<F extends TrashingFs>(fs: F, edit: () => unknown): F {
  let edited = false;
  return {
    ...fs,
    trashEntry: async (args) => {
      if (!edited) {
        edited = true;
        await edit();
      }
      for (const held of args.unchanged ?? []) {
        // A file that cannot be read now is not as it was read: the host refuses it too.
        const now = await fs.readTextFile(held.path).catch(() => null);
        if (now?.modified !== held.modified || now.text !== held.text) {
          throw new EntryChangedError(`${held.path} changed since it was read`);
        }
      }
      await fs.trashEntry(args);
    },
  };
}
