import type {
  ActivityStore,
  IndexEntry,
  IndexPort,
  SyncFileName,
  SyncFilesPort,
  VaultLocation,
  VaultLocationStore,
} from '@dfai/application';

/**
 * What the web stub keeps for the page's session (#656): every write is held
 * and read back, none outlives a reload. The browser's own storage and the
 * GitHub vault take their places (#664–#667). What the shell already keeps in
 * the browser's storage (the sync's pause, Granola's records) it keeps there.
 */

/** Where the open vault is remembered: the one it was handed, or what was written since. */
export function sessionVaultStore(start: VaultLocation): VaultLocationStore {
  let held: VaultLocation | null = start;
  return {
    read: async () => held,
    write: async (location) => {
      held = location;
    },
  };
}

/** Each vault's Activity log, kept whole per vault. */
export function sessionActivityStore(): ActivityStore {
  const logs = new Map<string, string>();
  return {
    append: async ({ vault, text }) => {
      const next = (logs.get(vault) ?? '') + text;
      logs.set(vault, next);
      // The file's size in bytes, as the port asks and the host answers.
      return new TextEncoder().encode(next).byteLength;
    },
    read: async ({ vault }) => logs.get(vault) ?? '',
    replace: async ({ vault, text }) => {
      logs.set(vault, text);
    },
  };
}

/** The sync's own files of one vault, by name. */
export function sessionSyncFiles(): SyncFilesPort {
  const files = new Map<SyncFileName, string>();
  return {
    read: async (name) => files.get(name) ?? null,
    write: async (name, contents) => {
      if (contents === null) files.delete(name);
      else files.set(name, contents);
    },
  };
}

/**
 * An index that keeps what it is told is in it, so the shell sees its notes
 * as indexed, and answers every search and query with nothing: the browser's
 * SQLite index (#666) is what answers them.
 */
export function sessionIndex(): IndexPort {
  const notes = new Map<string, IndexEntry>();
  return {
    open: async () => ({ fresh: notes.size === 0 }),
    clear: async () => notes.clear(),
    manifest: async () => [...notes.values()],
    put: async (written) => {
      for (const { path, modified, size, digest, type } of written)
        notes.set(path, { path, modified, size, digest, type });
    },
    remove: async (paths) => {
      for (const path of paths) notes.delete(path);
    },
    search: async () => [],
    notesOfType: async () => [],
    rebuildViews: async () => {},
    query: async () => ({ columns: [], rows: [], truncated: false }),
    backlinks: async () => [],
    stats: async () => ({ notes: notes.size, properties: 0, links: 0 }),
  };
}
