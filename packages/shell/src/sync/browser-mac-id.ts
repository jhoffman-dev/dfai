const KEY = 'atlas.mac-id';

/**
 * This Mac's id (A29-01), made once and kept in the app's own storage — per
 * Mac, never in the vault — so the Mac that runs a synced vault's automations
 * is known by something a rename, or a second Mac of the same name, does not
 * change.
 *
 * Should storage be out of reach (it throws where site data is blocked), the
 * id lasts this session only: this Mac is then never taken for the one named
 * in the settings, so it runs no scheduled rules rather than doubling them.
 */
export function browserMacId(make: () => string): () => Promise<string> {
  let session: string | null = null;
  return async () => {
    try {
      const kept = window.localStorage.getItem(KEY);
      if (kept !== null && kept.trim() !== '') return kept;
      const made = make();
      window.localStorage.setItem(KEY, made);
      return made;
    } catch {
      // Safe to ignore: the session's own id stands in, as said above.
      session ??= make();
      return session;
    }
  };
}
