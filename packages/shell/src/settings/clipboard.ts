/** Somewhere text can be put for the person to paste elsewhere. */
export interface ClipboardWriter {
  write(text: string): Promise<void>;
}

/** The system clipboard, through the webview. */
export const browserClipboard: ClipboardWriter = {
  write: (text) => navigator.clipboard.writeText(text),
};
