/**
 * A table cell is one line of markdown (GFM): the editor lets any block into
 * one, markdown holds only a line of text there. So a paragraph is the one
 * block a cell can take — its words run into the line — and any other block
 * put in a cell is refused, at the drop (#569) and again at the save, rather
 * than written as a line that is not it, or as nothing.
 */

/** The editor's cell blocks: a body cell and a header cell. */
export const TABLE_CELL_TYPES: ReadonlySet<string> = new Set(['tableCell', 'tableHeader']);

/** Whether a block of `type` can be put in a table cell and written as the cell's line. */
export const fitsInTableCell = (type: string): boolean => type === 'paragraph';
