import { describe, expect, it } from 'vitest';
import { notePassages, type NoteFile } from '@dfai/application';
import { remarkMarkdown } from '../markdown/markdown-port.ts';

/*
 * Attack round on PR #538 (#33): Obsidian `%%` comments against the real
 * markdown reader. ADR-0031: "`%%…%%` comments are never embedded or shown";
 * ADR-0043 §8 counts a mark "only in text, never in a fenced or indented code
 * block, an inline code span or inline HTML".
 */

const file = (text: string): NoteFile => ({
  path: 'Review/Tobias Fenn.md',
  text,
  modified: 1,
  size: text.length,
});
const words = (text: string) =>
  notePassages(file(text), remarkMarkdown).chunks.map((chunk) => chunk.words);

describe('attack-538: what an Obsidian comment covers is never embedded', () => {
  it('a fenced code block inside an open %% comment is hidden with the rest of the comment', () => {
    const text = [
      'Shown before.',
      '',
      '%% private notes for the review',
      '',
      '```',
      'salary: 91,000 for Tobias Fenn',
      '```',
      '',
      'end of it %%',
      '',
      'Shown after.',
    ].join('\n');
    const all = words(text).join(' | ');
    expect(all).not.toContain('91,000');
  });
});

describe('attack-538: a %% in inline code is code, not a comment', () => {
  it('an inline code span holding %% does not hide the rest of the note', () => {
    const text = [
      'Escape a percent in the template as `%%` before saving.',
      '',
      'Mara Quill moves payday to Friday.',
    ].join('\n');
    expect(words(text)).toContain('Mara Quill moves payday to Friday.');
  });
});
