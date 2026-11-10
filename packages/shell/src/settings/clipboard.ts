/** Somewhere text can be put for the person to paste elsewhere. */
export interface ClipboardWriter {
  write(text: string): Promise<void>;
}

/**
 * The system clipboard, through the webview. A webview with none — the web
 * build over plain http has no `navigator.clipboard` — refuses as a clipboard
 * that denies does: `async`, so the missing one rejects and never throws.
 */
export const browserClipboard: ClipboardWriter = {
  write: async (text) => navigator.clipboard.writeText(text),
};
