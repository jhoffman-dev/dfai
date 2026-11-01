/**
 * Bytes as git and GitHub's API carry them (#664): base64 both ways, and a
 * blob's git name, `sha1("blob <length>\0" + bytes)`, which is how a write
 * names the blob it expects to replace without reading it again. No Node:
 * the webview has none (#53), so base64 goes through `btoa`/`atob`.
 */

const encoder = new TextEncoder();

/** A note's text as the bytes git stores: UTF-8, a byte-order mark kept if the text holds one. */
export const utf8 = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text);

/**
 * The text of a file's bytes, or null when they are not UTF-8. A byte-order
 * mark is kept, not stripped, so a note read and saved unedited is the same
 * bytes (ADR-0003); line endings and a last newline are never touched.
 */
export function textOfBytes(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    // Not UTF-8: the host refuses such a file as text, and the caller says so.
    return null;
  }
}

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

/**
 * A blob's version, where the desktop has a modification time: the first 52
 * bits of its sha, so it is a safe integer, changes whenever the bytes do,
 * and is the same for whoever reads the same blob. It is not a time (#666).
 */
export const versionOfBlob = (sha: string): number => Number.parseInt(sha.slice(0, 13), 16);
