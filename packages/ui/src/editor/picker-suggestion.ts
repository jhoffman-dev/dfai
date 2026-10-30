import type { Editor, Range } from '@tiptap/core';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';

/** What a caret popup shows: its items, which is selected, where, and how to pick one. */
export interface PickerView<Item> {
  readonly items: readonly Item[];
  /** The item Enter picks, or -1 when Enter picks nothing and makes a new line. */
  readonly selected: number;
  readonly rect: DOMRect | null;
  readonly insert: (item: Item) => void;
  /** Picks an item the other way — `[[`'s bookmark — or null where there is none. */
  readonly insertAlternate?: (item: Item) => void;
}

/** An item picked the other way, with what the popup's own command is given. */
export type AlternateCommand<Item> = (picked: { editor: Editor; range: Range; item: Item }) => void;

/**
 * A suggestion that offers a list under the caret — `[[` notes, `/` blocks,
 * `#` tags.
 *
 * The plugin owns which item is selected and handles the arrow keys itself,
 * because the keystrokes have to be intercepted before ProseMirror sees them.
 * React is handed a plain snapshot and only draws it.
 */
export function pickerSuggestion<Item>({
  find,
  onView,
  preselects = () => true,
  alternate = null,
  ...options
}: Omit<SuggestionOptions<Item>, 'items' | 'render' | 'decorationClass'> & {
  /**
   * The items for what has been typed so far — at once, or once a note has
   * been read (the `#` of a link). An answer overtaken by later typing is dropped.
   */
  find: (query: string, editor: Editor) => Item[] | Promise<Item[]>;
  /** Called whenever the popup should appear, move, or close. */
  onView: (view: PickerView<Item> | null) => void;
  /**
   * Whether the first item may be what Enter picks before an arrow key is
   * pressed. When not, nothing is selected, and Enter is left to the editor.
   */
  preselects?: (item: Item) => boolean;
  /** What Shift+Enter (or a Shift-click) picks an item as, where there is another way. */
  alternate?: AlternateCommand<Item> | null;
}) {
  let items: Item[] = [];
  let selected = 0;
  let asked = 0;

  const settle = (found: Item[]) => {
    items = found;
    const first = items[0];
    selected = first !== undefined && preselects(first) ? 0 : -1;
    return items;
  };

  return Suggestion<Item>({
    ...options,
    // Named rather than left as the default `suggestion`, which once collided
    // with the popup's own class and pushed the caret to the start of the line.
    decorationClass: 'atlas-suggestion',
    items: ({ query, editor }) => {
      const found = find(query, editor);
      if (Array.isArray(found)) return settle(found);
      const ticket = (asked += 1);
      // Typing on while a note is read asks again; only the latest answer is shown.
      // A read that fails clears the popup rather than leaving the last answer on
      // it: the suggestion re-renders with these items. The failure is still the
      // suggestion's to see, which ends its loading on it.
      return found.then(
        (answer) => (ticket === asked ? settle(answer) : items),
        (cause: unknown) => {
          if (ticket === asked) settle([]);
          throw cause;
        },
      );
    },
    render: () => {
      // onKeyDown is given neither the caret rectangle nor the insert command,
      // so both are kept from the most recent start/update.
      let rect: DOMRect | null = null;
      let insert: ((item: Item) => void) | null = null;
      let insertOther: ((item: Item) => void) | null = null;
      const publish = () =>
        onView({
          items,
          selected,
          rect,
          insert: (item) => insert?.(item),
          ...(alternate !== null && { insertAlternate: (item: Item) => insertOther?.(item) }),
        });
      const follow = (props: {
        editor: Editor;
        range: Range;
        clientRect?: (() => DOMRect | null) | null;
        command: (item: Item) => void;
      }) => {
        rect = props.clientRect?.() ?? null;
        insert = (item) => props.command(item);
        insertOther = (item) => alternate?.({ editor: props.editor, range: props.range, item });
        publish();
      };

      return {
        onStart: follow,
        onUpdate: follow,
        onExit: () => onView(null),
        onKeyDown: ({ event }) => {
          if (items.length === 0) return false;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            const step = event.key === 'ArrowDown' ? 1 : -1;
            // From nothing selected, down is the first and up the last.
            const from = selected === -1 ? (step === 1 ? -1 : 0) : selected;
            selected = (from + step + items.length) % items.length;
            publish();
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const item = items[selected];
            const pick =
              event.key === 'Enter' && event.shiftKey && alternate !== null ? insertOther : insert;
            if (item === undefined || pick === null) return false;
            pick(item);
            return true;
          }
          if (event.key === 'Escape') {
            onView(null);
            return true;
          }
          return false;
        },
      };
    },
  });
}
