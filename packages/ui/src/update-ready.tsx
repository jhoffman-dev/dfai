/**
 * The web build's offer of a newer build (#668): a line at the foot of the
 * window, beside the sign-out, with the one thing to do about it. Whether
 * it shows is the page's to say (apps/web/src/pwa); this only draws it.
 */
export function UpdateReadyBar({ onReload }: { readonly onReload: () => void }) {
  return (
    <div role="status" className="update-ready">
      <span>Update ready</span>
      <button type="button" className="btn btn--primary btn--sm" onClick={onReload}>
        Reload
      </button>
    </div>
  );
}
