/**
 * Putting an image into a note whatever its size, over an API whose host
 * takes at most 1 MiB per request.
 *
 * One that fits in a chunk is sent whole. A larger one is sent as an upload:
 * the first chunk is answered with an upload id, every next chunk carries it
 * at the offset the last answer ended at, and the last says so — only then
 * does DFAI check the whole image and put it in place, under the name asked
 * for, numbered when that is taken. Then, unless asked not to, the image's
 * markdown is appended to the note. DFAI checks the kind, the bytes and the
 * size, and says where it goes; this checks only what it reads from disk
 * (`local-image.ts`) and that nothing too large is sent at all.
 */

import { basename, extname } from 'node:path';
import type { ApiImageUpload, ApiNote, ApiNoteImage } from '@dfai/application';
import { bytesFromBase64, CHUNK_BYTES } from './artifact-upload.ts';
import { AtlasCallError, type AtlasClient } from './client.ts';
import { imageFolders, imageKindOf, readLocalImage, sameKind } from './local-image.ts';

export interface ImageUpload {
  /** The note the image is for. */
  readonly note: string;
  /** An image file on this computer, by its absolute path. */
  readonly file?: string | undefined;
  /** Or the image itself, as base64, with `name` saying what it is. */
  readonly base64?: string | undefined;
  /** The file name to save it under, with its extension; `file`'s own name when omitted. */
  readonly name?: string | undefined;
  /** Whether to append `![alt](src)` to the note. Default true. */
  readonly insert?: boolean | undefined;
}

export interface UploadedImage {
  readonly image: ApiNoteImage;
  /** The note after the image was appended to it; absent when `insert` was false. */
  readonly note?: ApiNote;
}

export async function uploadImage(
  client: AtlasClient,
  upload: ImageUpload,
  maxBytes: number,
): Promise<UploadedImage> {
  const { name, bytes } = await imageOf(upload, maxBytes);
  const image = await sendInChunks(client, { note: upload.note, name, bytes });
  if (upload.insert === false) return { image };
  try {
    const { note } = await client.append(upload.note, { markdown: image.markdown });
    return { image, note };
  } catch (error) {
    if (!(error instanceof AtlasCallError)) throw error;
    throw new AtlasCallError(
      `The image was saved at ${image.path}, but not added to the note: ${error.message}. ` +
        `Add ${image.markdown} to it yourself.`,
    );
  }
}

/** The image's name and bytes, from a file on disk or from base64 — exactly one of them. */
async function imageOf(
  upload: ImageUpload,
  maxBytes: number,
): Promise<{ name: string; bytes: Buffer }> {
  if ((upload.file === undefined) === (upload.base64 === undefined)) {
    throw new AtlasCallError('give exactly one of file and base64');
  }
  if (upload.file !== undefined) {
    const name = upload.name ?? basename(upload.file);
    refuseChangedKind({ file: upload.file, name });
    return { name, bytes: await readLocalImage(upload.file, imageFolders(), maxBytes) };
  }
  if (upload.name === undefined) throw new AtlasCallError('name is required with base64');
  const bytes = bytesFromBase64(upload.name, upload.base64 ?? '', {
    bytes: maxBytes,
    refusal: `${upload.name} is larger than the 20 MB an image in a note can be.`,
  });
  return { name: upload.name, bytes };
}

/** A file is saved as the kind it is: `name` may rename it, never make it another kind. */
function refuseChangedKind({ file, name }: { file: string; name: string }): void {
  const kind = imageKindOf(file);
  const named = imageKindOf(name);
  if (kind !== null && (named === null || !sameKind(kind, named))) {
    throw new AtlasCallError(
      `name must keep the file's own extension (${extname(file)}): it cannot change its kind`,
    );
  }
}

async function sendInChunks(
  client: AtlasClient,
  { note, name, bytes }: { note: string; name: string; bytes: Buffer },
): Promise<ApiNoteImage> {
  const chunkAt = (offset: number) =>
    bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64');
  if (bytes.byteLength <= CHUNK_BYTES) {
    return imageFrom(await client.writeNoteImage(note, name, { base64: chunkAt(0) }));
  }
  const started = await client.writeNoteImage(note, name, { base64: chunkAt(0), last: false });
  const { id } = uploadFrom(started);
  let answer = started;
  for (let offset = CHUNK_BYTES; offset < bytes.byteLength; offset += CHUNK_BYTES) {
    const last = offset + CHUNK_BYTES >= bytes.byteLength;
    answer = await client.writeNoteImage(note, name, {
      base64: chunkAt(offset),
      offset,
      upload: id,
      last,
    });
  }
  const image = imageFrom(answer);
  if (image.size !== bytes.byteLength) {
    throw new AtlasCallError(`${image.path} is ${image.size} bytes, not ${bytes.byteLength}`);
  }
  return image;
}

type ImageAnswer = { image: ApiNoteImage } | { upload: ApiImageUpload };

function imageFrom(answer: ImageAnswer): ApiNoteImage {
  if ('image' in answer) return answer.image;
  throw new AtlasCallError('DFAI did not say where it saved the image');
}

function uploadFrom(answer: ImageAnswer): ApiImageUpload {
  if ('upload' in answer) return answer.upload;
  throw new AtlasCallError('DFAI did not start an upload for the image');
}
