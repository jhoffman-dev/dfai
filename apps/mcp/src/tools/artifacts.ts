/** Saving a Claude artifact into DFAI: `/v1/artifacts`. */

import { z } from 'zod';
import { uploadArtifact } from '../artifact-upload.ts';
import { defineTool, definedOnly } from './define.ts';

const file = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      'Path inside the artifact\'s folder, e.g. "app.css" or "img/logo.png". Only html, css, js, ' +
        'json, svg, png, jpg, webp and woff2 files.',
    ),
  text: z.string().optional().describe('The file as text (html, css, js, json, svg).'),
  base64: z.string().optional().describe('The file as base64, for a picture or a font.'),
});

export const saveArtifact = defineTool({
  name: 'atlas_save_artifact',
  title: 'Save an artifact',
  description:
    'Save a Claude artifact you made into DFAI in one call: a note in the "artifacts" folder ' +
    'holding its link, kind, project and tags, and — when you pass "html" — a copy of the page ' +
    'that opens offline inside DFAI. Pass the complete HTML of the page; any size works, large ' +
    'pages are sent in chunks. Put its other files (stylesheets, scripts, pictures) in "files", ' +
    "named as the page refers to them. DFAI then pictures the page as the note's thumbnail. " +
    'Returns { note, files }, and "thumbnail" saying why when no picture could be made.',
  inputSchema: z.object({
    title: z.string().min(1).describe('What the artifact is called; the note is named after it.'),
    url: z
      .string()
      .optional()
      .describe('Its link, e.g. "https://claude.ai/artifact/…". http or https only.'),
    kind: z
      .enum(['page', 'deck', 'design', 'doc', 'other'])
      .optional()
      .describe('What it is. Guessed from the page when omitted.'),
    project: z.string().optional().describe("The project it belongs to, by the project's name."),
    tags: z.array(z.string()).optional(),
    html: z.string().optional().describe('The whole page, saved as its index.html.'),
    files: z.array(file).optional().describe("The page's other files, if it has any."),
    body: z.string().optional().describe("Markdown notes about the artifact, for its note's body."),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  call: (client, input, { artifactFileBytes }) =>
    uploadArtifact(client, definedOnly(input), artifactFileBytes),
});

export const artifactTools = [saveArtifact];
