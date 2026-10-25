/** Putting an image into a note: `/v1/notes/{path}/images/{name}`, then an append. */

import { z } from 'zod';
import { uploadImage } from '../image-upload.ts';
import { defineTool, definedOnly } from './define.ts';
import { notePath } from './inputs.ts';

export const addImage = defineTool({
  name: 'atlas_add_image',
  title: 'Add an image to a note',
  description:
    'Save an image into the vault for a note and show it at the end of the note, as pasting one ' +
    'into DFAI does. DFAI puts it where Settings → Images says (the "attachments" folder, or ' +
    'beside the note), numbers the name if it is taken, and never overwrites a file. PNG, JPEG, ' +
    'GIF, WebP, SVG or HEIC, up to 20 MB; the bytes must really be that kind of image. Give ' +
    'either "file", an image on this computer, or "base64" with a "name". A "file" is read only ' +
    'from Desktop, Downloads, Pictures or the temporary folder (or the folders ' +
    'ATLAS_MCP_IMAGE_DIRS names), and "name" may rename it but not change its extension. ' +
    'Returns { image, note }: ' +
    'image.markdown is what was appended. Pass insert: false to only save it, then place ' +
    'image.markdown yourself with atlas_replace_note_body.',
  inputSchema: z.object({
    path: notePath,
    file: z
      .string()
      .optional()
      .describe(
        'Absolute path of an image in Desktop, Downloads, Pictures or the temporary folder, ' +
          'e.g. "/Users/me/Desktop/shot.png".',
      ),
    base64: z.string().optional().describe('The image as base64, instead of "file".'),
    name: z
      .string()
      .optional()
      .describe(
        'File name with extension, e.g. "Q3 chart.png". Required with base64; with "file" it ' +
          "must keep the file's extension.",
      ),
    insert: z
      .boolean()
      .optional()
      .describe('Append the image to the end of the note. Default true.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  call: (client, { path, ...rest }, { imageBytes }) =>
    uploadImage(client, { note: path, ...definedOnly(rest) }, imageBytes),
});

export const imageTools = [addImage];
