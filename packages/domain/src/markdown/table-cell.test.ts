import { describe, expect, it } from 'vitest';
import { TABLE_CELL_TYPES, fitsInTableCell } from './table-cell.ts';

describe('what a table cell can hold', () => {
  it('takes a paragraph: its words are the cell’s line', () => {
    expect(fitsInTableCell('paragraph')).toBe(true);
  });

  it.each(['rawBlock', 'bulletList', 'listItem', 'heading', 'blockquote', 'codeBlock', 'table'])(
    'refuses a %s, which a line of markdown cannot be',
    (type) => {
      expect(fitsInTableCell(type)).toBe(false);
    },
  );

  it('knows both the body cell and the header cell', () => {
    expect([...TABLE_CELL_TYPES].sort()).toEqual(['tableCell', 'tableHeader']);
  });
});
