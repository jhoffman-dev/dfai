/**
 * Shown before a vault has been chosen — the only thing to do is choose one,
 * so the screen is a title, one paragraph and the ways to open one (UI v2
 * slice 13f: no tile, no card, no colour bigger than a button).
 */
export function VaultEmptyState({
  onChooseVault,
  onOpenFromGitHub,
}: {
  /** Given when a folder on disk can be opened as the vault. */
  onChooseVault?: () => void;
  /** Given when a vault can be copied from GitHub instead. */
  onOpenFromGitHub?: () => void;
}) {
  return (
    <div className="empty">
      <section className="empty__intro" aria-labelledby="empty-title">
        <h1 className="empty__title" id="empty-title">
          Open a vault
        </h1>
        <p className="empty__body">
          Choose the folder that holds your markdown notes. DFAI works on the files where they are —
          nothing is imported, moved or converted.
        </p>
        <div className="empty__actions">
          {onChooseVault !== undefined && (
            <button className="btn btn--secondary" type="button" onClick={onChooseVault}>
              Choose folder…
            </button>
          )}
          {onOpenFromGitHub !== undefined && (
            <button className="btn btn--secondary" type="button" onClick={onOpenFromGitHub}>
              Open a vault from GitHub…
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
