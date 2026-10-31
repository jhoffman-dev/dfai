import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { escapeLeftByEditor } from '../editor/escape-unused.ts';
import { Icon, type IconName } from '../icon.tsx';
import { isImeKey } from '../ime.ts';
import { KeyHints } from '../key-hints.tsx';
import { PageMenu, type PageMenuItem } from '../page-bar.tsx';
import { useReturnFocus, type FocusFallback } from '../return-focus.ts';
import {
  peekKeyAction,
  peekKeyPlace,
  peekWhere,
  steppedIndex,
  type PeekRowAt,
} from './peek-keys.ts';

/** The row the peek shows, in the list it was opened from: "3 of 186 in Task table". */
export interface PeekPosition extends PeekRowAt {
  /** What the list is, as the header names it. */
  readonly within: string;
}

export interface PeekDialogProps {
  /** The note's title: the dialog's name. */
  title: string;
  /** Where its row sits; null for a note opened from no list, which then has no stepping. */
  position: PeekPosition | null;
  /** The save state, as a page's bar says it: Saved, Unsaved, Saving…. */
  status: ReactNode;
  /** Shows the row at `index` of the same list instead. */
  onStep: (index: number) => void;
  onClose: () => void;
  /**
   * Whether something is open above the peek — the search palette, a menu —
   * whose Escape it is. Read as the key goes down, before either dialog has
   * answered it. Left out, nothing ever is.
   */
  covered?: () => boolean;
  /** An Escape pressed while `covered`: the peek stays, and what is above closes instead. */
  onEscapeAbove?: () => void;
  /** Opens the note as the page, in place of the tab under the peek. */
  onExpand?: () => void;
  onOpenInNewTab?: () => void;
  onOpenInSplit?: () => void;
  /** The ⋯ menu's commands; left out, there is no menu. */
  menu?: readonly PageMenuItem[];
  /** Where the focus goes on closing when the row that opened the peek has gone. */
  fallbackFocus?: FocusFallback;
  /** Where the dialog is drawn: the document's body, unless given (the gallery's themed panels). */
  container?: RefObject<HTMLElement | null>;
  /**
   * Given a place inside the dialog — after its header, before the note — for
   * the window's toasts, so they are in its focus trap and Tab reaches their
   * Undo; told null as the dialog goes.
   */
  toastSlot?: (element: HTMLElement | null) => void;
  /** The note: `NotePane` with `chrome="peek"`. */
  children: ReactNode;
}

/**
 * The center peek (brief §5.1, FlowPeek.dc.html): a note over the view it was
 * opened from, 840px on a scrim, with a 44px header — previous and next row,
 * where the row sits, the save state, expand, new tab, split, ⋯ and × — the
 * note itself, and its keys along a 34px foot.
 *
 * Modal, so the focus stays in it; Esc or × closes it and hands the focus
 * back to the row that opened it. Its keys are `peekKeyAction`'s (Q6). It
 * answers nothing else and stops nothing else, so ⌘K still reaches the app.
 *
 * Base UI's Esc is refused when something inside — a suggestion list, a
 * field putting its value back — already took it, which its dismissal does
 * not check on its own. A step first lets a field being typed in commit to its
 * own note, then keeps the focus in the peek when what held it is replaced.
 */
export function PeekDialog(props: PeekDialogProps) {
  const finalFocus = useReturnFocus(props.fallbackFocus);
  const popup = useRef<HTMLDivElement>(null);
  const shown = props.position?.index;
  useLayoutEffect(() => keepFocusIn(popup.current), [shown]);
  const coveredEscapes = useCoveredEscapes(props.covered);
  return (
    <Dialog.Root
      open
      onOpenChange={(open, details) => {
        if (details.reason === 'escape-key' && coveredEscapes.has(details.event)) {
          details.cancel();
          props.onEscapeAbove?.();
          return;
        }
        if (details.reason === 'escape-key' && escapeTakenInside(details.event)) {
          details.cancel();
          return;
        }
        if (!open) props.onClose();
      }}
    >
      <Dialog.Portal {...(props.container !== undefined && { container: props.container })}>
        <Dialog.Backdrop className="peek__scrim" />
        <Dialog.Viewport className="peek__viewport">
          <Dialog.Popup
            ref={popup}
            className="peek"
            aria-label={props.title}
            initialFocus={popup}
            finalFocus={finalFocus}
            onKeyDown={(event) => answerPeekKey(event, props)}
          >
            <PeekHeader {...props} popup={popup} />
            {props.toastSlot !== undefined && <ToastPlace onPlace={props.toastSlot} />}
            <div className="peek__body">{props.children}</div>
            <KeyHints hints={hintsOf(props)} />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * An Escape something inside the peek already answered, or an input
 * method's. The editor prevents every Escape it is pressed in, so one it
 * says it left alone (`escapeLeftByEditor`) is the peek's to close on.
 */
function escapeTakenInside(event: Event): boolean {
  if (!(event instanceof globalThis.KeyboardEvent)) return false;
  const answered = event.defaultPrevented && !escapeLeftByEditor(event);
  return answered || event.isComposing || event.keyCode === 229;
}

/**
 * The Escapes pressed while something was open above the peek. Read on the
 * window, on the way down, so that what is above closing on the same key
 * first does not make it the peek's: two dialogs each dismiss on an Escape
 * pressed in the peek, and the palette's field takes the focus only after it
 * opens (on Linux WebKit, later than on macOS).
 */
function useCoveredEscapes(covered: (() => boolean) | undefined): WeakSet<Event> {
  const [escapes] = useState(() => new WeakSet<Event>());
  useLayoutEffect(() => {
    if (covered === undefined) return;
    const note = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && covered()) escapes.add(event);
    };
    window.addEventListener('keydown', note, { capture: true });
    return () => window.removeEventListener('keydown', note, { capture: true });
  }, [covered, escapes]);
  return escapes;
}

/** After a step: the focus back on the peek when what held it went or was disabled. */
function keepFocusIn(popup: HTMLElement | null): void {
  if (popup === null) return;
  const held = popup.ownerDocument.activeElement;
  if (held instanceof HTMLElement && popup.contains(held) && !held.matches(':disabled')) return;
  popup.focus();
}

function answerPeekKey(event: KeyboardEvent<HTMLElement>, props: PeekDialogProps): void {
  // Answered inside already — a suggestion list's arrows, the editor's own
  // keys, a field's Escape — or an input method's, or pressed in something
  // open above the peek, through a portal.
  if (event.defaultPrevented || isImeKey(event)) return;
  if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
  const action = peekKeyAction(event, peekKeyPlace(event.target));
  if (action === null) return;
  if (action.kind === 'step') {
    if (props.position === null) return;
    event.preventDefault();
    step(props, action.by, event.currentTarget);
    return;
  }
  const open = action.how === 'tab' ? props.onOpenInNewTab : props.onOpenInSplit;
  if (open === undefined) return;
  event.preventDefault();
  leaveWith(open, event.currentTarget);
}

/** Opens the note elsewhere once the field being typed in has committed to it, as a step does. */
function leaveWith(open: () => void, popup: HTMLElement | null): void {
  commitFocusedField(popup);
  open();
}

function step(props: PeekDialogProps, by: -1 | 1, popup: HTMLElement | null): void {
  if (props.position === null) return;
  const next = steppedIndex(props.position, by);
  if (next === null) return;
  commitFocusedField(popup);
  props.onStep(next);
}

/**
 * Leaves the field or the text the focus is in, so a draft that commits on
 * leaving (a date half-typed) is written to the note it belongs to, while
 * that note is still the one on screen.
 */
function commitFocusedField(popup: HTMLElement | null): void {
  const held = popup?.ownerDocument.activeElement;
  if (!(held instanceof HTMLElement) || held === popup || popup?.contains(held) !== true) return;
  if (peekKeyPlace(held) !== 'chrome') held.blur();
}

/** Where the window's toasts are drawn while the peek is up: in its focus trap. */
function ToastPlace({ onPlace }: { onPlace: (element: HTMLElement | null) => void }) {
  return <div className="peek__toasts" ref={onPlace} />;
}

function PeekHeader(props: PeekDialogProps & { popup: RefObject<HTMLElement | null> }) {
  const { position, popup, onExpand, onOpenInNewTab, onOpenInSplit } = props;
  return (
    <header className="peek__head">
      {position !== null && (
        <>
          <PeekButton
            icon="up"
            label="Previous row"
            framed
            disabled={steppedIndex(position, -1) === null}
            onClick={() => step(props, -1, popup.current)}
          />
          <PeekButton
            icon="down"
            label="Next row"
            framed
            disabled={steppedIndex(position, 1) === null}
            onClick={() => step(props, 1, popup.current)}
          />
          <span className="peek__where">{peekWhere(position)}</span>
        </>
      )}
      <span className="peek__gap" />
      <span className="peek__status" role="status">
        {props.status}
      </span>
      {onExpand !== undefined && (
        <PeekButton
          icon="arrow"
          label="Open as full page"
          onClick={() => leaveWith(onExpand, popup.current)}
        />
      )}
      {onOpenInNewTab !== undefined && (
        <PeekButton
          icon="tab"
          label="Open in new tab"
          onClick={() => leaveWith(onOpenInNewTab, popup.current)}
        />
      )}
      {onOpenInSplit !== undefined && (
        <PeekButton
          icon="split"
          label="Open in split"
          onClick={() => leaveWith(onOpenInSplit, popup.current)}
        />
      )}
      {props.menu !== undefined && (
        <PageMenu items={props.menu} open={undefined} onOpenChange={undefined} />
      )}
      <span className="peek__divider" aria-hidden="true" />
      <Dialog.Close className="icon-button peek__button" aria-label="Close" title="Close">
        <Icon name="close" size={15} />
      </Dialog.Close>
    </header>
  );
}

function PeekButton({
  icon,
  label,
  framed = false,
  disabled = false,
  onClick,
}: {
  icon: IconName;
  label: string;
  /** The stepping pair is outlined, as the mockup draws it; the rest are bare. */
  framed?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={
        framed ? 'icon-button peek__button peek__button--framed' : 'icon-button peek__button'
      }
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={framed ? 14 : 15} />
    </button>
  );
}

type Hint = readonly [keys: string, does: string];

/** The foot's key hints: only the keys that do something here. */
function hintsOf(props: PeekDialogProps): readonly Hint[] {
  const hints: Hint[] = [['esc', 'close']];
  if (props.position !== null) {
    hints.push(['↑ ↓', 'previous / next row'], ['⌥↑ ⌥↓', 'from the text']);
  }
  if (props.onOpenInNewTab !== undefined) hints.push(['⌘↵', 'open in tab']);
  if (props.onOpenInSplit !== undefined) hints.push(['⌘⇧↵', 'open in split']);
  return hints;
}
