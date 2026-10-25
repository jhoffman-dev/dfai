/**
 * The sizes the upload tools refuse at before sending anything: DFAI's own,
 * unless whoever builds the server (a test) gives smaller ones.
 */

import { MAX_ARTIFACT_FILE_BYTES } from './artifact-upload.ts';
import { MAX_IMAGE_BYTES } from './local-image.ts';

export interface UploadLimits {
  /** The largest file of an artifact's copy, in bytes. */
  readonly artifactFileBytes: number;
  /** The largest image for a note, in bytes, from disk or as base64. */
  readonly imageBytes: number;
}

export const UPLOAD_LIMITS: UploadLimits = {
  artifactFileBytes: MAX_ARTIFACT_FILE_BYTES,
  imageBytes: MAX_IMAGE_BYTES,
};
