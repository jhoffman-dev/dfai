/**
 * A switch. State is carried by the knob's position as well as its colour, so
 * it still reads for someone who cannot tell the two colours apart.
 *
 * A `button` rather than a checkbox: it already answers Space and Enter, and
 * `role="switch"` is what a screen reader wants to hear for an on/off control.
 *
 * Settings → Features (`feature-settings.tsx`) draws this markup in place,
 * not this component, to keep its rows free of renders: a change to the
 * markup or classes here is made there too.
 */
export function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  /** Read aloud in place of the knob, which has no text of its own. */
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="toggle"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle__knob" />
    </button>
  );
}
