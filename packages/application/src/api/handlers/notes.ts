import type { NOTE_ROUTES } from '../contract/notes.ts';
import { promoteLineRoute } from '../checklists.ts';
import { noteImageRoute } from '../images.ts';
import { createNoteRoute } from '../notes-create.ts';
import { exportNoteRoute } from '../notes-export.ts';
import { backlinksRoute, listNotes, readNoteRoute } from '../notes-read.ts';
import { appendRoute, replaceBodyRoute, setPropertiesRoute } from '../notes-write.ts';
import { relatedRoute } from '../related.ts';
import { type HandlerTable, vaultRoute, vaultWrite, created } from './route-handler.ts';

/** What answers each route for notes themselves: reading, writing, their links, exports and images. */
export const NOTE_HANDLERS: HandlerTable<typeof NOTE_ROUTES> = {
  'GET /v1/notes': vaultRoute(listNotes),
  'POST /v1/notes': vaultWrite(createNoteRoute),
  'GET /v1/notes/{path}': vaultRoute(readNoteRoute),
  'PATCH /v1/notes/{path}/properties': vaultWrite(setPropertiesRoute),
  'POST /v1/notes/{path}/append': vaultWrite(appendRoute),
  'PUT /v1/notes/{path}/body': vaultWrite(replaceBodyRoute),
  'GET /v1/notes/{path}/backlinks': vaultRoute(backlinksRoute),
  'GET /v1/notes/{path}/related': vaultRoute(relatedRoute),
  'POST /v1/notes/{path}/promote': vaultWrite(promoteLineRoute),
  'GET /v1/notes/{path}/export': vaultRoute(exportNoteRoute),
  'PUT /v1/notes/{path}/images/{name}': vaultWrite(noteImageRoute, created),
};
