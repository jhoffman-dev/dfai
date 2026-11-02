import INDEX_SCHEMA from '../../../../apps/desktop/src-tauri/src/index_schema.sql?raw';
import { webIndexShape } from './web-index-shape.ts';

/**
 * The browser index's shape, from the one file the host makes its tables
 * from (`index_schema.sql`), taken as text at build time (`?raw`) and never
 * copied (#134).
 */
export const WEB_INDEX = webIndexShape(INDEX_SCHEMA);
