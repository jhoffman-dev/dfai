/** Tools that read and write single notes: `/v1/notes/...`. */

import { z } from 'zod';
import { defineTool, definedOnly } from './define.ts';
import { ifModified, limit, notePath } from './inputs.ts';
import { TASK_STATUSES_DESCRIBED } from './task-statuses.ts';

const READ_ONLY = { readOnlyHint: true } as const;

const properties = z
  .record(z.string(), z.unknown())
  .describe('Frontmatter properties by key. Call atlas_list_types to see which keys a type has.');

export const listNotes = defineTool({
  name: 'atlas_list_notes',
  title: 'List notes',
  description:
    'List notes in the DFAI vault, optionally only those in a folder, of a type, or about a ' +
    'day ("date": named for it, or with that "date" property, as a meeting is), a page at a time ' +
    '(at most 500). Returns { notes: [{ path, title, type, modified }], next, total }: total is ' +
    'how many match in all. When "next" is not null, call again with it as "cursor" for the next ' +
    'page. To find notes by their words, use atlas_search instead; to ' +
    'filter by property values, use atlas_query.',
  inputSchema: z.object({
    folder: z.string().optional().describe('Vault-relative folder, e.g. "Projects".'),
    type: z.string().optional().describe('Only notes with this "type:" in their frontmatter.'),
    date: z.string().optional().describe('Only notes about this day, YYYY-MM-DD.'),
    limit: limit.optional(),
    cursor: z.string().optional().describe('The "next" value from the previous page.'),
  }),
  annotations: READ_ONLY,
  call: (client, input) => client.listNotes(definedOnly(input)),
});

export const readNote = defineTool({
  name: 'atlas_read_note',
  title: 'Read a note',
  description:
    'Read one note: its frontmatter properties, its markdown body, and "modified". Read a note ' +
    'before changing it, and pass its "modified" back as "ifModified" to any write, so a change ' +
    'made in the meantime is not overwritten.',
  inputSchema: z.object({ path: notePath }),
  annotations: READ_ONLY,
  call: (client, { path }) => client.readNote(path),
});

export const createNote = defineTool({
  name: 'atlas_create_note',
  title: 'Create a note',
  description:
    'Create a new note, optionally from a template (e.g. "Task", "Project" — the names ' +
    'atlas_list_templates gives). "properties" are set on top of the template\'s frontmatter; "body" replaces ' +
    'the template\'s body. Fails with "exists" if a note with that name is already in the folder. ' +
    'Returns the created note, including its path. For a quick task, atlas_capture_task is simpler.',
  inputSchema: z.object({
    folder: z
      .string()
      .optional()
      .describe(
        'Vault-relative folder, which must already exist: DFAI does not create folders, and a missing one fails with "not_found". Omit for the vault root.',
      ),
    name: z
      .string()
      .optional()
      .describe('The note\'s name, without ".md". Omit for "Untitled", numbered if taken.'),
    template: z
      .string()
      .optional()
      .describe('A template name from atlas_list_templates, e.g. "Task".'),
    properties: properties.optional(),
    body: z.string().optional().describe('Markdown for the body.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  call: (client, input) => client.createNote(definedOnly(input)),
});

export const updateProperties = defineTool({
  name: 'atlas_update_properties',
  title: "Set a note's properties",
  description:
    'Set or remove frontmatter properties on a note, e.g. { "status": "done" }. Keys not named are ' +
    'left alone; a null value removes the key. Safe on a note open in DFAI: the change goes ' +
    'through its pane. Pass "ifModified" from your last read to refuse the write if the note ' +
    'changed since. Returns the updated note. ' +
    TASK_STATUSES_DESCRIBED,
  inputSchema: z.object({
    path: notePath,
    set: z.record(z.string(), z.unknown()).describe('Keys to set. A null value removes that key.'),
    ifModified: ifModified.optional(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  call: (client, { path, ...body }) => client.setProperties(path, definedOnly(body)),
});

export const appendToNote = defineTool({
  name: 'atlas_append_to_note',
  title: 'Append to a note',
  description:
    "Add markdown to the end of a note's body, after a blank line. Nothing already there is " +
    'changed. Refused with "unsaved_in_app" if the note has unsaved edits open in DFAI. Pass ' +
    '"ifModified" from your last read to refuse the write if the note changed since.',
  inputSchema: z.object({
    path: notePath,
    markdown: z.string().min(1).describe('Markdown to append.'),
    ifModified: ifModified.optional(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  call: (client, { path, ...body }) => client.append(path, definedOnly(body)),
});

export const replaceNoteBody = defineTool({
  name: 'atlas_replace_note_body',
  title: "Replace a note's body",
  description:
    'Replace everything after the frontmatter with new markdown; properties are kept. "ifModified" ' +
    'is required: call atlas_read_note first and pass its "modified", so edits made since cannot be ' +
    'lost. On "conflict", read the note again and redo the change. Refused with "unsaved_in_app" ' +
    'if the note has unsaved edits open in DFAI. To add to a note, prefer atlas_append_to_note.',
  inputSchema: z.object({
    path: notePath,
    markdown: z.string().describe('The whole new body, as markdown.'),
    ifModified: ifModified,
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  call: (client, { path, ...body }) => client.replaceBody(path, body),
});

export const backlinks = defineTool({
  name: 'atlas_backlinks',
  title: 'Backlinks',
  description:
    'List the notes that link to this one, by [[wiki link]] or relation property, a page at a ' +
    'time (at most 500). Returns { backlinks: [{ path, title, type, modified }], next, total }. ' +
    'When "next" is not null, call again with it as "cursor" for the next page.',
  inputSchema: z.object({
    path: notePath,
    limit: limit.optional(),
    cursor: z.string().optional().describe('The "next" value from the previous page.'),
  }),
  annotations: READ_ONLY,
  call: (client, { path, ...page }) => client.backlinks(path, definedOnly(page)),
});

export const related = defineTool({
  name: 'atlas_related',
  title: 'Related notes',
  description:
    'List the notes close in meaning to this one that are not linked to it yet, either way — ' +
    'neither by a [[wiki link]] in either note nor by a relation property — best first. Notes the ' +
    "person dismissed in the app's Related notes panel are kept on their Mac and still listed " +
    'here. Returns { related: [{ path, title, link, score }], ' +
    'embedded, progress: { done, total, failure } }. "link" is what to write to link one ' +
    '([[Note]], or [[Folder/Note]] where the name is shared); "score" is above 0 and at most 1, ' +
    'higher closer. Archived notes and templates are never listed. "embedded" is false, and "related" ' +
    'empty, while the note has no meanings cached yet. It works only where the person has turned ' +
    'on search by meaning in the app (⌘K, "By meaning"): this tool never turns it on, and answers ' +
    'semantic_off where it is off, so tell the person. Read-only: to link one, append its "link" ' +
    'with atlas_append_to_note.',
  inputSchema: z.object({
    path: notePath,
    limit: limit.max(50).optional(),
  }),
  annotations: READ_ONLY,
  call: (client, { path, ...query }) => client.related(path, definedOnly(query)),
});

export const exportNote = defineTool({
  name: 'atlas_export_note',
  title: 'Export a note',
  description:
    'A note made ready to leave DFAI, by "format" (default "confluence"). Returns { export: ' +
    '{ path, format, title, markdown, ... } }. "confluence": markdown for a Confluence page, ' +
    'with "dropped". In "markdown", each [[wiki link]] is its words (its alias, or the ' +
    "linked note's title), a block shown in place is quoted under the note it came from, and a " +
    'callout is a quote opening with its name in bold; tasks, tables, code and web links stay. ' +
    'Properties, block ids, comments and images in the vault are left out, and "dropped" lists ' +
    'everything left out, by kind: property, link, embed, missing-embed, image, block-id, ' +
    'comment, callout-fold, formatting (a block shared as plain words, named by its first ' +
    'line, because its rewrite would have read differently). DFAI writes nothing: to share ' +
    'the note, create the page with the ' +
    'Atlassian connector — "title" as its title, "markdown" as its body, in markdown format, ' +
    'passed verbatim: add, reword or reformat nothing, or "dropped" is no longer the whole ' +
    'story — and tell the user what "dropped" lists, so they can attach an image or fill a gap. ' +
    '"markdown": the file exactly as it is on disk, and "attachments": [{ path, as }], each ' +
    'picture its own blocks show, by vault path, with the file name a copy takes. ' +
    '"standalone": Markdown that reads without the vault — links as words, embedded notes ' +
    'inlined, each picture linked at "attachments/<name>" (each listed in "attachments" with ' +
    'that "as"), frontmatter kept unless "frontmatter" is "drop" — with "dropped". Pictures are ' +
    'listed, not sent: no DFAI tool reads a picture, so copy them some other way if needed. ' +
    'There is no PDF or Google Doc here: the API writes no file anywhere, a PDF is made by the ' +
    "app's own window, and a Google Doc needs the user's consent in their browser — ask the " +
    'user to export from the note\'s "⋯" menu, or ⌘K "Export…".',
  inputSchema: z.object({
    path: notePath,
    format: z
      .enum(['confluence', 'markdown', 'standalone'])
      .optional()
      .describe('Default "confluence".'),
    frontmatter: z
      .enum(['keep', 'drop'])
      .optional()
      .describe('For "standalone" only: keep (the default) or drop the frontmatter.'),
  }),
  annotations: READ_ONLY,
  call: (client, { path, ...query }) => client.exportNote(path, definedOnly(query)),
});

export const noteTools = [
  listNotes,
  readNote,
  createNote,
  updateProperties,
  appendToNote,
  replaceNoteBody,
  backlinks,
  related,
  exportNote,
];
