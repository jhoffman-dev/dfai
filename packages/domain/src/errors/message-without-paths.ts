/*
 * An error's words as they may leave the app — in an API answer, a rule's log
 * that any tool can read, or the Activity log. In the domain, so the API, the
 * automation runner and the Activity log strip paths by one rule.
 */

/** What an absolute path is struck to. */
export const PATH_PLACEHOLDER = '<path>';

/** The words for a thrown value that cannot be turned into any. */
export const UNDESCRIBED_ERROR = 'an error DFAI could not put into words';

/**
 * An error's own words, for a refusal whose cause the caller can act on.
 * Never throws: anything may be thrown, and some things — an object with no
 * prototype, one whose `toString` or `message` throws, a hostile proxy —
 * cannot be made text. Those are described as {@link UNDESCRIBED_ERROR}, so
 * whatever reports the error still does.
 */
export function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return UNDESCRIBED_ERROR;
  }
}

/**
 * An error's own words with every absolute path in them replaced, for a
 * refusal from the index: SQLite names the files it could not open, and the
 * caller has no business learning where things sit on this machine.
 */
export function messageWithoutPaths(error: unknown): string {
  const text = messageOf(error);
  let kept = '';
  let from = 0;
  for (const start of text.matchAll(PATH_START)) {
    // The lead is always matched, if only as the empty start of the text.
    const lead = start[1] ?? '';
    const at = start.index + lead.length;
    if (at < from) continue;
    const end = at + pathLength(text, at, lead);
    kept += `${text.slice(from, at)}${PATH_PLACEHOLDER}`;
    from = end;
  }
  return kept + text.slice(from);
}

/*
 * A path starts at `/`, `~/`, a drive letter (`C:\`, `C:/`) or a UNC share
 * (`\\server`), just after the start, a space, `=`, `:`, a comma or anything
 * that wraps it — a quote of any kind, a backtick or a bracket. It needs
 * something other than a space or a closer after its first separator, so a
 * lone `"/"` quoted back from a syntax error, or `a / b`, stays.
 */
const PATH_START =
  /(^|[\s=:,'"`‘’“”«»([{<])(?=(?:~?\/|[A-Za-z]:[\\/]|\\\\)[^\s'"`‘’“”«»()[\]{}<>])/g;

/** What closes a path that the character before it opened. */
const CLOSER: Readonly<Record<string, string>> = {
  '"': '"',
  "'": "'",
  '`': '`',
  '‘': '’',
  '“': '”',
  '«': '»',
  '(': ')',
  '[': ']',
  '{': '}',
  '<': '>',
};

/*
 * Folders hold spaces (`My Vault`, iCloud's `Mobile Documents`), so a path's
 * run goes on past them. A wrapped path runs to its closer. A bare one runs up
 * to a quote, a closing bracket, `: `, or the next path's start; it goes on
 * past an apostrophe, which a folder's name may hold (`Bob's Vault`).
 */
const BARE_STOP = /\n|:(?:\s|$)|["`“”»)\]}>]|\s+(?=~?\/|[A-Za-z]:[\\/]|\\\\)/g;

/** How long the path starting at `at` is: all of a wrapped one, else as {@link pathEnd} says. */
function pathLength(text: string, at: number, lead: string): number {
  const closer = CLOSER[lead];
  if (closer !== undefined) {
    const close = closingAt(text, at, closer);
    if (close !== -1) return close - at;
  }
  BARE_STOP.lastIndex = at + 1;
  const stop = BARE_STOP.exec(text);
  return pathEnd(text.slice(at, stop === null ? text.length : stop.index));
}

/**
 * Where the closer is, on this line; -1 when it is not. A closer with a letter
 * right after it is an apostrophe inside a name (`‘/Users/Bob’s Vault/a.md’`).
 */
function closingAt(text: string, at: number, closer: string): number {
  for (let i = at; i < text.length && text[i] !== '\n'; i++) {
    if (text[i] === closer && !/[\p{L}\p{N}]/u.test(text[i + 1] ?? '')) return i;
  }
  return -1;
}

/** A last word that names a file: `index.sqlite`, `Weekly Plan.md`. */
const FILE_NAME = /\.[A-Za-z0-9]+$/;

/** What may follow a path's last word in a sentence, and is not part of it. */
const TRAILING_PUNCTUATION = /[,;.!?]+$/;

/**
 * Where the path ends within its run: just past the last word that holds a
 * separator or names a file (`Plan.md` in `/a/Weekly Plan.md (os error 2`), so
 * the words after `/a.md because it is locked` stay. The first word always
 * holds a separator. Stripping too much is safe; too little leaks a folder.
 */
function pathEnd(run: string): number {
  let end = 0;
  for (const found of run.matchAll(/\S+/g)) {
    const word = found[0].replace(TRAILING_PUNCTUATION, '');
    if (/[/\\]/.test(word) || FILE_NAME.test(word)) end = found.index + word.length;
  }
  return end;
}
