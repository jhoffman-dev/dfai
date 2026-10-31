/**
 * The local API's contract for saved artifacts.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

import type { MAX_ARTIFACT_FILE_BYTES } from '@dfai/domain';

/** The kinds an artifact can be, as its `kind` property holds them. */
export type ApiArtifactKind = 'page' | 'deck' | 'design' | 'doc' | 'other';

export interface ApiSaveArtifactBody {
  /** What the artifact is called: its note's name, in `artifacts/`, numbered if taken. */
  readonly title: string;
  /** Its claude.ai link, or wherever else it lives. `http` or `https`. */
  readonly url?: string;
  /** Guessed from `html`, then from `url`, when not given. */
  readonly kind?: ApiArtifactKind;
  /** The project it belongs to, by the project note's name. */
  readonly project?: string;
  readonly tags?: readonly string[];
  /**
   * The page, saved as `index.html` in the artifact's own folder. The whole
   * request must fit the host's 1 MiB body cap; a larger page is sent without
   * this, then written in chunks with `PUT /v1/artifacts/{path}/files/index.html`.
   */
  readonly html?: string;
  /** Markdown for the note's body: notes about the artifact. */
  readonly body?: string;
}

/**
 * One chunk of a file in an artifact's saved copy. Exactly one of `text` and
 * `base64`. At `offset` 0 (the default) the file is created, and refused with
 * `exists` if it is there already; past 0 the chunk is added to the end of a
 * file that must be exactly `offset` bytes long, or it is refused with
 * `conflict`, so a retried or reordered chunk can never corrupt it.
 */
export interface ApiArtifactFileBody {
  /** The chunk as text, written as UTF-8. */
  readonly text?: string;
  /** The chunk as standard padded base64, for a picture or a font. */
  readonly base64?: string;
  readonly offset?: number;
}

/**
 * The largest file of a saved copy, in bytes, as a type: a client that refuses
 * a file before sending it keeps a copy typed with this, so the copy cannot
 * drift from DFAI's limit without a type error.
 */
export type ApiMaxArtifactFileBytes = typeof MAX_ARTIFACT_FILE_BYTES;

/** A file of a saved copy, after a chunk was written to it. */
export interface ApiArtifactFile {
  /** Vault-relative, forward slashes. */
  readonly path: string;
  /** Its length in bytes so far: the `offset` for the next chunk. */
  readonly size: number;
}

/** What the routes for saved artifacts answer with. */
export type ApiArtifactSuccessBody = { readonly file: ApiArtifactFile };

/** The routes for saved artifacts. */
export const ARTIFACT_ROUTES = [
  {
    method: 'POST',
    path: '/v1/artifacts',
    summary: 'Save a Claude artifact: its note, and a copy of its HTML when given.',
  },
  {
    method: 'PUT',
    path: '/v1/artifacts/{path}/files/{name}',
    summary: "Write a file of an artifact's saved copy, a chunk at a time.",
  },
  {
    method: 'POST',
    path: '/v1/artifacts/{path}/thumbnail',
    summary:
      "Picture an artifact's saved copy as its thumbnail and cover, unless its cover was set by hand.",
  },
] as const;
