/**
 * Bytes as git and GitHub's API carry them: base64 both ways, and a blob's
 * git name, `sha1("blob <length>\0" + bytes)`. No Node: the browser has no
 * `Buffer`, so base64 goes through `btoa`/`atob`. Lifted from DFAI's adapter.
 */

const encoder = new TextEncoder();

/** A note's text as the bytes git stores: UTF-8, a byte-order mark kept if the text holds one. */
export const utf8 = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text);

/**
 * The text of a file's bytes. A byte-order mark is kept, so a note read and
 * saved unedited is the same bytes; bytes that are not UTF-8 read with
 * replacement characters (such a file is only ever written back if edited).
 */
export const textOfBytes = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

/** Chunked, since spreading megabytes into one `fromCharCode` call overflows the stack. */
const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
  return btoa(binary);
}

/** The bytes of GitHub's base64, which breaks lines every 60 characters; null when it is not base64. */
export function base64ToBytes(text: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(text.replace(/\s+/g, ''));
  } catch {
    // Not base64: the answer is malformed, and the caller refuses it as such.
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Git's name for a blob of these bytes. */
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = utf8(`blob ${bytes.byteLength}\0`);
  const object = new Uint8Array(header.byteLength + bytes.byteLength);
  object.set(header);
  object.set(bytes, header.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', object));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Git's name for a blob holding this text as UTF-8: what sync compares remote shas with. */
export const gitBlobShaOfText = (text: string): Promise<string> => gitBlobSha(utf8(text));
