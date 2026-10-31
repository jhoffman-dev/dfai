import manrope from '@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2?inline';
import type { NotePageRenderer } from '@dfai/application';
import { createNotePageRenderer } from '@dfai/ui';

/**
 * How a note's page is drawn to be pictured: the app's reading schema and
 * light page look, with Manrope written into the page as a `data:` URL — the
 * page is loaded where nothing can be fetched.
 */
export const notePageRenderer: NotePageRenderer = createNotePageRenderer({ fontUrl: manrope });
