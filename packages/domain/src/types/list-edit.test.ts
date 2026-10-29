import { describe, expect, it } from 'vitest';
import { hasOpenQuote } from './list-input.ts';
import { listEditText, listFromEditText } from './list-edit.ts';

describe('hasOpenQuote', () => {
  it('is true while a quote is open around text, wherever the line ends', () => {
    expect(hasOpenQuote('"Payroll, Larkspur, Quill')).toBe(true);
    expect(hasOpenQuote('Payroll, "Quill, Mara')).toBe(true);
    expect(hasOpenQuote('Payroll, "say ""hi')).toBe(true);
  });

  it('is false once every quote is closed, or when a lone quote has nothing after it yet', () => {
    expect(hasOpenQuote('"Payroll, Larkspur", Quill')).toBe(false);
    expect(hasOpenQuote('"say ""hi""", Quill')).toBe(false);
    expect(hasOpenQuote('Quill, "')).toBe(false);
    expect(hasOpenQuote('Quill, "  ')).toBe(false);
    expect(hasOpenQuote('the "QD", x')).toBe(false);
    expect(hasOpenQuote('')).toBe(false);
  });
});

describe('listEditText', () => {
  it('shows the items in the list codec, empty ones left out and a line break as a space', () => {
    expect(listEditText(['Payroll, Larkspur', null, 7, true, 'line one\nline two'])).toBe(
      '"Payroll, Larkspur", 7, true, line one line two',
    );
    expect(listEditText('Quill')).toBe('Quill');
    expect(listEditText(null)).toBe('');
  });
});

describe('listFromEditText', () => {
  const held = ['Payroll, Larkspur', 7, false, 'line one\nline two', 'Quill'];

  it('gives back each item left as it was shown exactly as the file held it', () => {
    const typed = `${listEditText(held)}, Mara`;
    expect(listFromEditText(typed, held)).toEqual([...held, 'Mara']);
  });

  it('keeps the held items through a reorder and a removal', () => {
    expect(listFromEditText('Quill, line one line two, 7', held)).toEqual([
      'Quill',
      'line one\nline two',
      7,
    ]);
  });

  it('writes an item the person changed as the text typed', () => {
    expect(listFromEditText('8, Quill', held)).toEqual(['8', 'Quill']);
  });

  it('lets each held item answer for one typed item only', () => {
    expect(listFromEditText('7, 7', [7])).toEqual([7, '7']);
  });

  it('drops an empty held item rather than writing it as text', () => {
    expect(listFromEditText('Quill, Mara', ['Quill', null])).toEqual(['Quill', 'Mara']);
  });

  it('saves nothing while a quote is open around text', () => {
    expect(listFromEditText('"Payroll, Larkspur, Quill', held)).toBeNull();
    expect(listFromEditText('"Payroll, Larkspur", Quill, "', held)).toEqual([
      'Payroll, Larkspur',
      'Quill',
    ]);
  });
});
