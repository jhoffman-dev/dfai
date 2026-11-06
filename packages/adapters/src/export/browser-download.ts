/** One file handed to the person as a download. */
export interface DownloadFile {
  readonly name: string;
  /** Its media type: "text/markdown", "application/zip". */
  readonly type: string;
  readonly bytes: Uint8Array;
}

export type BrowserDownload = (file: DownloadFile) => Promise<void>;

/**
 * How long the file's address outlives the click. WebKit reads a blob URL
 * after the click returns, so letting it go at once can cancel the download.
 */
const KEEP_URL_MS = 60_000;

/** A download through the page (#774): the bytes as a Blob, clicked as a link that says `download`. */
export function browserDownload(page: Document = document): BrowserDownload {
  return (file) => {
    // The export makes its bytes on ordinary ArrayBuffers; the cast only narrows what TypeScript allows.
    const url = URL.createObjectURL(
      new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.type }),
    );
    const link = page.createElement('a');
    link.href = url;
    link.download = file.name;
    link.rel = 'noopener';
    link.style.display = 'none';
    page.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), KEEP_URL_MS);
    return Promise.resolve();
  };
}
