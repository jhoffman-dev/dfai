/**
 * What a tab on a switched-off feature's page shows in its place (#901): the
 * feature is off, nothing of it is gone, and the way to switch it back on.
 * The tab stays open, so switching the feature on shows the page again.
 */
export function FeatureOffNotice({
  label,
  onTurnOn,
}: {
  /** The feature, as Settings → Features names it. */
  label: string;
  /** Opens Settings at Features. */
  onTurnOn: () => void;
}) {
  return (
    <div className="viewer" role="status">
      <p>
        <strong>{label} is turned off</strong>
      </p>
      <p>Its notes and files are all still here. Turn it on to open this again.</p>
      <button type="button" className="btn btn--sm" onClick={onTurnOn}>
        Turn on in Settings
      </button>
    </div>
  );
}
