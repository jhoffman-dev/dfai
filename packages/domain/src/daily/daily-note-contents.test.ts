import { describe, expect, it } from 'vitest';
import { splitFrontmatter } from '../markdown/markdown-document.ts';
import { readQueryBlock } from '../query-block/query-block.ts';
import { parseAtlasQuery } from '../query-language/parse.ts';
import { dailyDaySections, dailyNoteContents } from './daily-note-contents.ts';

const DAY = '2026-10-28';

/** The fenced `atlas-query` texts a note holds, in order. */
function queryBlocksOf(contents: string): string[] {
  return [...contents.matchAll(/^```atlas-query\n([\s\S]*?)\n```$/gm)].map((match) => match[1]!);
}

describe("today's note without a Daily template (#110)", () => {
  it('is a note of the Daily type', () => {
    expect(splitFrontmatter(dailyNoteContents(DAY)).frontmatter).toMatch(/^type: daily$/m);
  });

  it('starts with the day — due and overdue, then next actions — above what happened and what is next', () => {
    const headings = [...dailyNoteContents(DAY).matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual(['Due and overdue', 'Next actions', 'What happened', 'What is next']);
  });

  it('holds each section of the day as a live query block under its heading, listed as a list', () => {
    const contents = dailyNoteContents(DAY);
    const blocks = queryBlocksOf(contents);
    expect(blocks).toEqual(dailyDaySections(DAY).map((section) => section.block));
    for (const block of blocks) {
      const reading = readQueryBlock(block);
      expect(reading).toMatchObject({ ok: true, layout: 'list' });
      if (reading.ok) expect(() => parseAtlasQuery(reading.query)).not.toThrow();
    }
    expect(contents.indexOf('## Due and overdue')).toBeLessThan(contents.indexOf(blocks[0]!));
    expect(contents.indexOf(blocks[1]!)).toBeLessThan(contents.indexOf('## What happened'));
  });

  it("names the note's own day rather than @today, so an old note keeps its day", () => {
    const blocks = dailyDaySections(DAY).map((section) => section.block);
    for (const block of blocks) {
      expect(block).toContain(DAY);
      expect(block).not.toContain('@today');
    }
    expect(dailyDaySections('2026-11-02')[0]?.block).toContain('due <= 2026-11-02');
  });

  it('asks only open work for what is due: Someday, Longterm and finished work promise no day', () => {
    const due = dailyDaySections(DAY)[0]!.block;
    for (const status of ['inbox', 'backlog', 'next-action', 'in-progress', 'waiting']) {
      expect(due).toContain(`status = ${status}`);
    }
    for (const status of ['someday', 'longterm', 'archive']) {
      expect(due).not.toContain(`status = ${status}`);
    }
  });

  it('is the same text every time for the same day: the file is written once, byte-stable', () => {
    expect(dailyNoteContents(DAY)).toBe(dailyNoteContents(DAY));
    expect(dailyNoteContents(DAY).endsWith('## What is next\n')).toBe(true);
  });

  it('refuses a day that is not YYYY-MM-DD rather than write a query that cannot run', () => {
    for (const bad of ['', '2026-1-2', '@today', '2026-10-28 OR 1', 'tomorrow']) {
      expect(() => dailyNoteContents(bad)).toThrow(RangeError);
    }
  });
});
