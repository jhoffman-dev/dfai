import { hasOpenQuote, listAsInput, listFromInput } from './list-input.ts';

/*
 * A list property edited as one line of text (the properties panel's
 * multi-select). The line can only show text, while the file's items can be
 * more: a number (`007` read as 7), a tick, an empty item, a value holding a
 * line break. Each keystroke is a save, so an item the person did not touch
 * must come back exactly as the file held it, never as the text it was shown as.
 */

/** The file's items as the box shows them: empty ones left out, a line break shown as a space. */
export function listEditText(value: unknown): string {
  return listAsInput(shownItems(value).map(({ text }) => text));
}

/**
 * The list a line typed into the box saves, or null while a quote is open
 * around text (`hasOpenQuote`): until it closes, which items the line holds
 * cannot be told, and saving it would merge the items after it into one.
 *
 * Each item typed exactly as one of the file's items was shown is that item,
 * as the file held it — so editing one item rewrites only that one. Each of
 * the file's items answers for one typed item at most.
 */
export function listFromEditText(typed: string, value: unknown): unknown[] | null {
  if (hasOpenQuote(typed)) return null;
  const unused = shownItems(value);
  return listFromInput(typed).map((text) => {
    const at = unused.findIndex((item) => item.text === text);
    if (at === -1) return text;
    const [kept] = unused.splice(at, 1);
    return kept?.held ?? text;
  });
}

interface ShownItem {
  readonly held: unknown;
  readonly text: string;
}

function shownItems(value: unknown): ShownItem[] {
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value])
    .filter((held) => held !== null && held !== undefined)
    .map((held) => ({
      held,
      text: String(held)
        .replace(/\s*[\r\n]+\s*/gu, ' ')
        .trim(),
    }))
    .filter(({ text }) => text !== '');
}
