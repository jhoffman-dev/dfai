import type { PhoneScreen } from '@dfai/domain';
import { Icon, type IconName } from './icon.tsx';

/** Each screen's glyph and the word under it. */
const SCREENS: Readonly<Record<PhoneScreen, { readonly icon: IconName; readonly label: string }>> =
  {
    'quick-add': { icon: 'plus', label: 'Quick add' },
    today: { icon: 'sun', label: 'Today' },
    notes: { icon: 'search', label: 'Notes' },
  };

/**
 * The bar along a phone's bottom edge (#672): the screens a thumb reaches,
 * in the order the rule names them (`shellLayoutFor`, the domain). Which
 * screens there are and whether there is a bar at all is the rule's; this
 * draws the buttons and says which screen is showing.
 */
export function PhoneBar({
  screens,
  current,
  onOpen,
}: {
  screens: readonly PhoneScreen[];
  /** The screen the pane shows, marked as where you are; null where it shows none of them. */
  current: PhoneScreen | null;
  onOpen: (screen: PhoneScreen) => void;
}) {
  return (
    <nav className="shell__bar" aria-label="Screens">
      {screens.map((screen) => {
        const { icon, label } = SCREENS[screen];
        return (
          <button
            key={screen}
            type="button"
            className="shell__bar-button"
            aria-current={current === screen ? 'page' : undefined}
            onClick={() => onOpen(screen)}
          >
            <span className="shell__bar-glyph">
              <Icon name={icon} size={20} />
            </span>
            {label}
          </button>
        );
      })}
    </nav>
  );
}
