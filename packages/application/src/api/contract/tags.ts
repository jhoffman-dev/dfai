/**
 * The local API's contract for tags.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

/** One tag in the vault's tree of tags, as the tags page shows it. */
export interface ApiTag {
  /** The whole name, as it was first written: `para/resource`. Its key in `/v1/tags/{tag}`. */
  readonly name: string;
  /** The last part of it, `resource`. */
  readonly label: string;
  /** Uses of this exact tag. A parent only ever written with a child has none. */
  readonly count: number;
  /** Uses of it and of every tag nested under it. */
  readonly total: number;
  readonly children: readonly ApiTag[];
}

/** A note using a tag, or one nested under it. */
export interface ApiTaggedNote {
  readonly path: string;
  readonly title: string;
  /** How many times the note uses the tag and those nested under it. */
  readonly uses: number;
}

export interface ApiRenameTagBody {
  /** The new name, with or without its `#`. Nested parts are separated by `/`. */
  readonly to: string;
  /** True: answer what the rename would change, and write nothing. */
  readonly dryRun?: boolean;
  /**
   * Required when the new name is a tag in use already, or the parent of one:
   * the two become one, and renaming back cannot part them again. The preview's
   * `mergesInto` says so, and it is asked again just before writing.
   */
  readonly merge?: boolean;
}

/** What renaming a tag changes, worked out from the notes themselves. */
export interface ApiTagRenamePreview {
  /** The tag renamed, as the vault spells it. */
  readonly from: string;
  readonly to: string;
  /** How many notes it rewrites. */
  readonly files: number;
  /** How many uses of the tag, and of those nested under it, it rewrites. */
  readonly uses: number;
  /**
   * A tag in use already — or the parent of one — that this one, or one nested
   * under it, would join; null when none.
   */
  readonly mergesInto: string | null;
  /** The notes it rewrites, each with its uses. */
  readonly notes: readonly ApiTaggedNote[];
  /**
   * Notes using the tag that are not rewritten, with why: in `.atlas` or a
   * hidden folder, which the API may not write, or where the new name could
   * not be written so that it reads back as that tag (ADR-0018).
   */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

/** What a rename did, note by note. */
export interface ApiTagRenameReport {
  readonly updated: readonly string[];
  /** Notes not rewritten, with why: typed in and not yet saved, changed meanwhile, … */
  readonly failed: readonly { readonly path: string; readonly reason: string }[];
}

/** What the routes for tags answer with. */
export type ApiTagSuccessBody =
  | { readonly tags: readonly ApiTag[] }
  | {
      readonly tag: ApiTag;
      readonly notes: readonly ApiTaggedNote[];
      readonly next: string | null;
      /** How many notes use the tag in all, over every page (#214). */
      readonly total: number;
    }
  | { readonly rename: ApiTagRenamePreview; readonly report?: ApiTagRenameReport };

/** The routes for tags. */
export const TAG_ROUTES = [
  {
    method: 'GET',
    path: '/v1/tags',
    summary: 'Every tag in the vault, nested, with its uses. Query: sort (name or frequency).',
  },
  {
    method: 'GET',
    path: '/v1/tags/{tag}/notes',
    summary: 'The notes using a tag or one nested under it. Query: limit, cursor.',
  },
  {
    method: 'POST',
    path: '/v1/tags/{tag}/rename',
    summary: 'Rename a tag in every note using it, as the tags page does; dryRun previews it.',
  },
] as const;
