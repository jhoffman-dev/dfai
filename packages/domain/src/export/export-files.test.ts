import { describe, expect, it } from 'vitest';
import type { VaultPath } from '../vault/vault-path.ts';
import {
  attachmentFileNames,
  defaultDriveFolderName,
  exportFileName,
  exportFileStem,
  exportFolderName,
  isExportFormat,
  markdownHref,
  uniqueFileNames,
} from './index.ts';

describe('export file names (#501)', () => {
  it('makes a title a file name any file system takes', () => {
    expect(exportFileStem('Q3: plan / review?')).toBe('Q3- plan - review-');
    expect(exportFileStem('..hidden')).toBe('hidden');
    expect(exportFileStem('Notes. ')).toBe('Notes');
    expect(exportFileStem('tab\there')).toBe('tab-here');
    expect(exportFileStem('   ')).toBe('Untitled');
    expect(exportFileStem('...')).toBe('Untitled');
    expect(exportFileName('Kickoff with Larkspur', 'md')).toBe('Kickoff with Larkspur.md');
  });

  it('cuts a long title by bytes, never inside a character, so every name made from it fits 255', () => {
    const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
    const stem = exportFileStem('é'.repeat(200));
    expect(bytes(stem)).toBe(234);
    expect(bytes(exportFileStem('議事録'.repeat(50)))).toBeLessThanOrEqual(234);
    expect(bytes(`${exportFileStem('🙂'.repeat(100))} attachments 999`)).toBeLessThanOrEqual(255);
    expect(exportFileStem(`${'a'.repeat(233)} b`)).toBe('a'.repeat(233));
  });

  it('composes a title, so one typed two ways is one name (NFC)', () => {
    expect(exportFileStem('Cafe\u0301')).toBe('Caf\u00e9');
    expect(uniqueFileNames(['Caf\u00e9', 'Cafe\u0301', 'CAF\u00c9'], 'md')).toEqual([
      'Caf\u00e9.md',
      'Caf\u00e9 2.md',
      'CAF\u00c9 3.md',
    ]);
  });

  it('numbers names that only differ in case, as a Mac’s disk compares them', () => {
    expect(uniqueFileNames(['Notes', 'notes', 'Notes', 'Plan'], 'pdf')).toEqual([
      'Notes.pdf',
      'notes 2.pdf',
      'Notes 3.pdf',
      'Plan.pdf',
    ]);
  });

  it('copies each attachment once, under its own name, numbering a clash', () => {
    const names = attachmentFileNames([
      'attachments/plan.png',
      'Projects/plan.png',
      'attachments/plan.png',
      'Projects/README',
      'archive/Plan.PNG',
      'x/plan.v2.png',
      'y/Cafe\u0301.png',
      'z/caf\u00e9.png',
    ] as VaultPath[]);
    expect([...names.values()]).toEqual([
      'plan.png',
      'plan 2.png',
      'README',
      'Plan 3.PNG',
      'plan.v2.png',
      'Caf\u00e9.png',
      'caf\u00e9 2.png',
    ]);
  });

  it('makes a dash of what no file system takes in a picture name, so it copies anywhere (#779)', () => {
    const names = attachmentFileNames([
      'a/back\\slash.png',
      'b/tab\tand\u0001bell.png',
      'c/colon:star*.png',
      'd/back\\slash.png',
    ] as VaultPath[]);
    expect([...names.values()]).toEqual([
      'back-slash.png',
      'tab-and-bell.png',
      'colon-star-.png',
      'back-slash 2.png',
    ]);
  });

  it('writes a relative path as a link that a space or bracket cannot end', () => {
    expect(markdownHref('Kickoff attachments/chart (1).png')).toBe(
      'Kickoff%20attachments/chart%20%281%29.png',
    );
    expect(markdownHref('a]b.md')).toBe('a%5Db.md');
  });

  it('names folders after the day and the app, as given', () => {
    expect(exportFolderName('2026-10-21')).toBe('Exported notes 2026-10-21');
    expect(defaultDriveFolderName('Northwind')).toBe('Northwind exports');
  });

  it('knows its formats', () => {
    expect(isExportFormat('pdf')).toBe(true);
    expect(isExportFormat('docx')).toBe(false);
  });
});
