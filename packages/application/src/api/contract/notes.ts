/**
 * The local API's contract for notes themselves: reading, writing, their links,
 * exports and images.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

import type { ExportDropKind, MAX_IMAGE_BYTES } from '@dfai/domain';
import type { ApiSemanticProgress } from './search.ts';

/** A note as a list entry: enough to choose it, not its contents. */
export interface ApiNoteSummary {
  /** Vault-relative, forward slashes, with the `.md`. The note's identity. */
  readonly path: string;
  readonly title: string;
  /** The `type:` in its frontmatter, or null. */
  readonly type: string | null;
  /**
   * The file's modification time in milliseconds, as the host reports it.
   * Pass it back as `ifModified` to write only if nothing changed in between.
   */
  readonly modified: number;
}

/** A whole note. */
export interface ApiNote extends ApiNoteSummary {
  /** The frontmatter, parsed. Values are whatever YAML made of them. */
  readonly properties: Readonly<Record<string, unknown>>;
  /** Everything after the frontmatter, as markdown, byte for byte. */
  readonly body: string;
}

/** One kind of thing a note's export left out, and each one, as the note writes it. */
export interface ApiExportDrops {
  readonly kind: ExportDropKind;
  /** Once each, in the order the note has them. */
  readonly items: readonly string[];
}

/**
 * `GET /v1/notes/{path}/export`: a note made ready to leave DFAI, by `format`
 * — for a Confluence page (P32-07), or as Markdown (#501). DFAI writes nothing.
 */
export type ApiNoteExport = ApiConfluenceExport | ApiMarkdownExport | ApiStandaloneExport;

/** `format=confluence`: the note as a Confluence page's body. */
export interface ApiConfluenceExport {
  readonly path: string;
  readonly format: 'confluence';
  /** The note's title, as its page shows it: the title for the page. */
  readonly title: string;
  /** The page's body, as markdown: properties left out, links as their words. */
  readonly markdown: string;
  /** Everything left out, by kind. Empty when nothing was. */
  readonly dropped: readonly ApiExportDrops[];
}

/** A picture in the vault an exported note shows, and the name a copy of it goes by. */
export interface ApiExportAttachment {
  /** The picture's vault path, in user space. */
  readonly path: string;
  /** For `markdown`, the file name a copy takes; for `standalone`, the path the Markdown links to. */
  readonly as: string;
}

/** `format=markdown`: the note as it is, and the pictures its own blocks show. */
export interface ApiMarkdownExport {
  readonly path: string;
  readonly format: 'markdown';
  readonly title: string;
  /** The file's text, byte for byte: frontmatter, line endings and a byte-order mark as they are. */
  readonly markdown: string;
  readonly attachments: readonly ApiExportAttachment[];
}

/** `format=standalone`: the note as Markdown that reads without DFAI or the vault. */
export interface ApiStandaloneExport {
  readonly path: string;
  readonly format: 'standalone';
  readonly title: string;
  /**
   * Wiki links as their words, embeds inlined, each picture linked at
   * `attachments/<name>`; the frontmatter kept unless `frontmatter=drop`.
   */
  readonly markdown: string;
  /** Each picture the Markdown links to, `as` the `attachments/<name>` it links to. */
  readonly attachments: readonly ApiExportAttachment[];
  /** Everything left out, by kind. Empty when nothing was. */
  readonly dropped: readonly ApiExportDrops[];
}

/** A note close in meaning to another and not linked to it yet (`/v1/notes/{path}/related`, P32-03). */
export interface ApiRelatedNote {
  readonly path: string;
  readonly title: string;
  /** `[[Note]]`, or `[[Folder/Note]]` where the name is shared: what to write to link it. */
  readonly link: string;
  /** Cosine similarity of its closest block to the note, above 0 and at most 1; higher is closer. */
  readonly score: number;
}

export interface ApiCreateNoteBody {
  /** Vault-relative folder. Omitted: the vault's root. */
  readonly folder?: string;
  /** The note's name, without `.md`. Omitted: "Untitled", numbered if taken. */
  readonly name?: string;
  /** A template's name from `.atlas/templates`, e.g. "Task". */
  readonly template?: string;
  /** Frontmatter to set on top of the template's. */
  readonly properties?: Readonly<Record<string, unknown>>;
  /** Markdown for the body. Replaces the template's body when given. */
  readonly body?: string;
}

export interface ApiSetPropertiesBody {
  /** Keys to set. A null value removes the key. */
  readonly set: Readonly<Record<string, unknown>>;
  /** Optional: refuse with `conflict` unless the note's `modified` still equals this. */
  readonly ifModified?: number;
}

export interface ApiAppendBody {
  /** Markdown added after the existing body, separated by a blank line. */
  readonly markdown: string;
  readonly ifModified?: number;
}

export interface ApiReplaceBodyBody {
  readonly markdown: string;
  /**
   * Required. A replace without it would be a blind overwrite of whatever the
   * note says now, which is exactly how edits get lost.
   */
  readonly ifModified: number;
}

/**
 * `POST /v1/notes/{path}/promote`: a checklist line of the note to make a task
 * (P30-03), named by its words — and, where two lines say the same, by its
 * place among the note's boxes, counting from 0 in the order they are written,
 * nested ones after the line they are under.
 */
export interface ApiPromoteLineBody {
  /** The line's words as the note writes them, without its box: "Order chairs". */
  readonly text: string;
  /** Its place among the note's boxes; needed only when another line says the same. */
  readonly line?: number;
}

/**
 * One chunk of an image for a note. Exactly one of `text` and `base64`.
 *
 * An image that fits in one request is sent whole: offset 0, `last` left out
 * or true. It is checked and saved under the name asked for, numbered clear
 * of any file already there, and the answer is `{ image }`.
 *
 * A larger one is staged outside the notes until it is whole: the first
 * chunk (offset 0, `last: false`) answers `{ upload: { id, size } }`; every
 * next chunk carries that `upload` id and the `size` the last answer gave as
 * its `offset`, and the final one says `last: true`. Only then is the whole
 * image checked and moved into place, answering `{ image }`. Nothing in the
 * vault is ever appended to, and an upload given up on leaves no file there.
 */
export interface ApiNoteImageBody {
  /** The chunk as text, written as UTF-8: an SVG. */
  readonly text?: string;
  /** The chunk as standard padded base64. */
  readonly base64?: string;
  /** Where the chunk goes: 0, the default, or the `size` the last answer gave. */
  readonly offset?: number;
  /** The id the first chunk's answer gave; required past offset 0, refused at it. */
  readonly upload?: string;
  /** Whether this chunk ends the image. Default true. */
  readonly last?: boolean;
}

/** The largest image for a note, in bytes, as a type: see ApiMaxArtifactFileBytes. */
export type ApiMaxImageBytes = typeof MAX_IMAGE_BYTES;

/** An image being staged a chunk at a time, before its last chunk arrives. */
export interface ApiImageUpload {
  /** Send it as `upload` with every next chunk. */
  readonly id: string;
  /** Bytes received so far: the `offset` for the next chunk. */
  readonly size: number;
}

/** An image saved for a note, once it is whole. */
export interface ApiNoteImage {
  /** Vault-relative, forward slashes: where Settings → Images puts a note's images. */
  readonly path: string;
  /** Its length in bytes. */
  readonly size: number;
  /** The image's destination relative to the note, percent-encoded. */
  readonly src: string;
  readonly alt: string;
  /** `![alt](src)`: what the note writes to show it. The note itself is not changed. */
  readonly markdown: string;
}

/** What the routes for notes themselves: reading, writing, their links, exports and images answer with. */
export type ApiNoteSuccessBody =
  | {
      readonly notes: readonly ApiNoteSummary[];
      readonly next: string | null;
      /** How many notes match in all, over every page (#214). */
      readonly total: number;
    }
  | { readonly note: ApiNote }
  | { readonly note: ApiNote; readonly task: ApiNote }
  | {
      readonly backlinks: readonly ApiNoteSummary[];
      readonly next: string | null;
      /** How many notes link to it in all, over every page (#214). */
      readonly total: number;
    }
  | {
      readonly related: readonly ApiRelatedNote[];
      /** False while the note has no meanings cached yet: nothing can be related to it. */
      readonly embedded: boolean;
      readonly progress: ApiSemanticProgress;
    }
  | { readonly image: ApiNoteImage }
  | { readonly upload: ApiImageUpload }
  | { readonly export: ApiNoteExport };

/** The routes for notes themselves: reading, writing, their links, exports and images. */
export const NOTE_ROUTES = [
  {
    method: 'GET',
    path: '/v1/notes',
    summary: 'List notes. Query: folder, type, date, limit, cursor.',
  },
  { method: 'POST', path: '/v1/notes', summary: 'Create a note, optionally from a template.' },
  {
    method: 'GET',
    path: '/v1/notes/{path}',
    summary: 'Read a note: properties, body and modified time.',
  },
  {
    method: 'PATCH',
    path: '/v1/notes/{path}/properties',
    summary: 'Set or remove frontmatter properties.',
  },
  {
    method: 'POST',
    path: '/v1/notes/{path}/append',
    summary: 'Append markdown to the end of the body.',
  },
  {
    method: 'PUT',
    path: '/v1/notes/{path}/body',
    summary: 'Replace the body. Requires ifModified.',
  },
  { method: 'GET', path: '/v1/notes/{path}/backlinks', summary: 'Notes that link to this one.' },
  {
    method: 'GET',
    path: '/v1/notes/{path}/related',
    summary: 'Notes close in meaning and not linked to it yet, either way. Query: limit.',
  },
  {
    method: 'POST',
    path: '/v1/notes/{path}/promote',
    summary: 'Make a checklist line of a note a task of its own, linked both ways.',
  },
  {
    method: 'GET',
    path: '/v1/notes/{path}/export',
    summary:
      'A note as markdown for a Confluence page, as it is, or standalone. Query: format, frontmatter.',
  },
  {
    method: 'PUT',
    path: '/v1/notes/{path}/images/{name}',
    summary: 'Save an image for a note, a chunk at a time, where Settings → Images puts it.',
  },
] as const;
