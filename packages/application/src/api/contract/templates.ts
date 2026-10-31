/**
 * The local API's contract for templates.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

/**
 * Something that makes notes from a template (ADR-0026): new notes of a type,
 * today's note, captured tasks, or saved artifacts. A template with none is
 * offered only in the New menu, and by name to `POST /v1/notes`.
 */
export type ApiTemplateUse =
  | { readonly kind: 'type'; readonly type: string; readonly label: string }
  | { readonly kind: 'daily' }
  | { readonly kind: 'capture' }
  | { readonly kind: 'artifact' };

/** A template in `.atlas/templates`, as the Templates page lists it. */
export interface ApiTemplate {
  /** Its file name without the extension: what `POST /v1/notes { template }` takes. */
  readonly name: string;
  /** Its file, under `.atlas/templates`. Read-only: the API never writes there. */
  readonly path: string;
  /** What makes notes from it; empty when only the New menu offers it. */
  readonly uses: readonly ApiTemplateUse[];
}

/** A template and what a note made from it starts with. */
export interface ApiTemplateContent extends ApiTemplate {
  /** Its frontmatter, parsed: the properties a new note starts with. */
  readonly properties: Readonly<Record<string, unknown>>;
  /** Everything after the frontmatter, as markdown, byte for byte. */
  readonly body: string;
}

/** What the routes for templates answer with. */
export type ApiTemplateSuccessBody =
  | {
      readonly templates: readonly ApiTemplate[];
      /** Types no template serves yet: a new note of one starts empty. */
      readonly typesWithoutTemplate: readonly string[];
    }
  | { readonly template: ApiTemplateContent };

/** The routes for templates. */
export const TEMPLATE_ROUTES = [
  {
    method: 'GET',
    path: '/v1/templates',
    summary: 'Every template, with what makes notes from each. Read-only.',
  },
  {
    method: 'GET',
    path: '/v1/templates/{name}',
    summary: "One template's properties and body, by name. Read-only.",
  },
] as const;
