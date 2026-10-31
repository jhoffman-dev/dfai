import type { ImageProbePort } from '@dfai/application';

/** Long enough for a 20 MB photo to decode; short enough that a hung decode is not a hung paste. */
const DECODE_TIMEOUT_MS = 10_000;

/**
 * Asks the webview itself whether it can draw an image, by decoding it as an
 * `<img>` would. That is the only honest answer to "can this Mac show a HEIC
 * photo", and it also catches a file that is named like an image but is not
 * one. An SVG is decoded as an image too, so its scripts never run.
 */
export const webviewImageProbe: ImageProbePort = {
  canShow: async ({ bytes, mimeType }) => {
    // Bytes read from a File are always over a plain ArrayBuffer, never a shared one.
    const url = URL.createObjectURL(
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }),
    );
    try {
      const image = new Image();
      image.src = url;
      await withTimeout(image.decode(), DECODE_TIMEOUT_MS);
      return true;
    } catch {
      // A decode that fails or never finishes means the webview cannot draw it,
      // which is the answer asked for rather than an error.
      return false;
    } finally {
      URL.revokeObjectURL(url);
    }
  },
};

function withTimeout(promise: Promise<void>, milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('the image took too long to decode')),
      milliseconds,
    );
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
