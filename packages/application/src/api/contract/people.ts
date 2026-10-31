/**
 * The local API's contract for people: duplicates and merging them.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

/** A person, as a possible duplicate names them. */
export interface ApiDuplicatePerson {
  readonly path: string;
  readonly name: string;
}

/** Why two people may be one (#464). */
export type ApiDuplicateReason =
  | { readonly kind: 'same-email'; readonly email: string }
  | { readonly kind: 'same-name' }
  | { readonly kind: 'alias'; readonly alias: string }
  | {
      readonly kind: 'similar-email';
      readonly left: string;
      readonly right: string;
      /** `same` (dots aside), `first-name` (`mara`, `mara.quill`) or `typo`. */
      readonly local: 'same' | 'first-name' | 'typo';
      readonly sameDomain: boolean;
    };

/** Two people who may be one, surest reason first; `left` sorts before `right` by path. */
export interface ApiDuplicatePair {
  readonly left: ApiDuplicatePerson;
  readonly right: ApiDuplicatePerson;
  readonly reasons: readonly ApiDuplicateReason[];
}

export interface ApiMergePeopleBody {
  /** The person to keep. */
  readonly keep: string;
  /** The people merged into them, then put in the Trash. */
  readonly merge: readonly string[];
  /** True: make the merge. Absent or false: answer what it would do, and write nothing. */
  readonly confirm?: boolean;
  /**
   * With `confirm`: the `version` of the preview the caller was shown. The
   * merge is made only while the vault still gives that preview.
   */
  readonly version?: string;
}

/** What merging people would do, worked out from the notes themselves; nothing written. */
export interface ApiPeopleMergePreview {
  readonly keep: string;
  readonly merge: readonly string[];
  /** Why it cannot be done, or null. */
  readonly refusal: string | null;
  /** Each note written, with how many of its links move to the kept person; the kept note last. */
  readonly notes: readonly { readonly path: string; readonly links: number }[];
  /** How many links, in every note, move to the kept person. */
  readonly links: number;
  /** A value the kept note keeps, though a merged note says otherwise. */
  readonly conflicts: readonly {
    readonly key: string;
    readonly kept: unknown;
    readonly other: unknown;
    readonly from: string;
  }[];
  readonly aliasesAdded: readonly string[];
  readonly emailsAdded: readonly string[];
  /** Each merged body added to the kept note, by the heading it goes under. */
  readonly appended: readonly { readonly from: string; readonly heading: string }[];
  /** What this preview was worked out from: send it back with `confirm` to make this merge. */
  readonly version: string;
}

/** What a merge did, file by file: each file changed whole, or left exactly as it was. */
export interface ApiPeopleMergeReport {
  readonly written: readonly string[];
  /** Planned writes not made, because an earlier one failed. */
  readonly notWritten: readonly string[];
  readonly trashed: readonly string[];
  readonly notTrashed: readonly string[];
  readonly failures: readonly {
    readonly path: string;
    readonly step: 'write' | 'trash';
    readonly reason: string;
  }[];
  readonly links: number;
}

/** What the routes for people: duplicates and merging them answer with. */
export type ApiPeopleSuccessBody =
  | { readonly pairs: readonly ApiDuplicatePair[] }
  | { readonly merge: ApiPeopleMergePreview; readonly report?: ApiPeopleMergeReport };

/** The routes for people: duplicates and merging them. */
export const PEOPLE_ROUTES = [
  {
    method: 'GET',
    path: '/v1/people/duplicates',
    summary:
      'Pairs of people who may be one person: the same name, an alias, or alike addresses; surest first.',
  },
  {
    method: 'POST',
    path: '/v1/people/merge',
    summary:
      'Merge people into one, as the app does: previews unless confirm, then rewrites links and trashes the merged.',
  },
] as const;
