import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  compileMarkedMeetingsQuery,
  LINKING_FAILED,
  linkingFailed,
  linkingFailedStamp,
  linkingOwed,
  MARKED_MEETINGS_PAGE,
  markedMeetingsOf,
  MEETING_LINKS_KEY,
  meetingsToRelink,
  RELINKS_PER_RUN,
} from './meeting-relink.ts';

const p = createVaultPath;
const MEETING = p('Inbox/Meetings/2026-10-06 Standup.md');

describe('the mark of linking that failed', () => {
  it('is what the stamp write adds, and what is read back as failed', () => {
    expect(linkingFailedStamp()).toEqual({ atlas_links: 'failed' });
    expect(linkingFailed(linkingFailedStamp())).toBe(true);
  });

  it.each([
    ['a list, by its first item', ['failed'], true],
    ['with spaces round it', '  failed ', true],
    ['absent', undefined, false],
    ['an empty list', [], false],
    ['another word', 'done', false],
    ['a list whose first item is another word', ['done', 'failed'], false],
    ['not text', 1, false],
    ['null', null, false],
  ])('reads %s', (_, value, failed) => {
    const properties = value === undefined ? {} : { [MEETING_LINKS_KEY]: value };
    expect(linkingFailed(properties)).toBe(failed);
  });

  it('is DFAI’s own key', () => {
    expect(MEETING_LINKS_KEY).toBe('atlas_links');
    expect(LINKING_FAILED).toBe('failed');
  });
});

describe('meetingsToRelink', () => {
  const failed = (path: string) => ({ path: p(path), properties: linkingFailedStamp() });
  const linked = (path: string) => ({ path: p(path), properties: { people: ['[[Mara Quill]]'] } });

  it('is none when every meeting is linked', () => {
    expect(meetingsToRelink([linked('A.md'), linked('B.md')])).toBeNull();
    expect(meetingsToRelink([])).toBeNull();
  });

  it('takes only those whose linking failed, in the order given, each once', () => {
    const notes = [failed('B.md'), linked('A.md'), failed('C.md'), failed('B.md')];
    expect(meetingsToRelink(notes)).toEqual({ paths: ['B.md', 'C.md'], capped: false });
  });

  it('stops at the cap, and says more wait', () => {
    const notes = ['A.md', 'B.md', 'C.md'].map(failed);
    expect(meetingsToRelink(notes, 2)).toEqual({ paths: ['A.md', 'B.md'], capped: true });
    expect(meetingsToRelink(notes, 3)).toEqual({ paths: ['A.md', 'B.md', 'C.md'], capped: false });
  });

  it('caps at fifty by default', () => {
    const notes = Array.from({ length: RELINKS_PER_RUN + 1 }, (_, at) => failed(`M${at}.md`));
    const found = meetingsToRelink(notes);
    expect(RELINKS_PER_RUN).toBe(50);
    expect(found?.paths).toHaveLength(RELINKS_PER_RUN);
    expect(found?.capped).toBe(true);
  });
});

describe('linkingOwed: the one rule the import marks by and Run now keeps the mark by', () => {
  const set = (key: string) => ({
    kind: 'set',
    path: MEETING,
    key,
    before: { absent: true },
    after: { value: [] },
  });
  const leftHere = {
    path: MEETING,
    reason: 'Its people has changed since, so it was left as it is.',
  };

  it('is owed when linking threw, and gave no run', () => {
    expect(linkingOwed(null)).toBe(true);
  });

  it('is owed when it wrote nothing into the meeting and left the meeting', () => {
    expect(linkingOwed({ meeting: MEETING, done: [], left: [leftHere] })).toBe(true);
  });

  it('is settled once it wrote anything into the meeting, even with a key left', () => {
    expect(linkingOwed({ meeting: MEETING, done: [set('companies')], left: [leftHere] })).toBe(
      false,
    );
  });

  it('is settled when it had nothing to add, or left only a proposal', () => {
    expect(linkingOwed({ meeting: MEETING, done: [], left: [] })).toBe(false);
    const proposal = { path: p('Inbox/Proposals/Ada Venn.md'), reason: 'disk full' };
    expect(linkingOwed({ meeting: MEETING, done: [], left: [proposal] })).toBe(false);
  });

  it('does not count a write somewhere else as one into the meeting', () => {
    const elsewhere = { kind: 'proposed', path: p('Inbox/Proposals/Ada Venn.md') };
    expect(linkingOwed({ meeting: MEETING, done: [elsewhere], left: [leftHere] })).toBe(true);
  });
});

describe('the index query for marked meetings', () => {
  it('asks for the paths that hold the mark, one page of them', () => {
    const { sql, parameters } = compileMarkedMeetingsQuery();
    expect(sql).toContain('SELECT DISTINCT path FROM props');
    expect(parameters).toEqual([MEETING_LINKS_KEY, MARKED_MEETINGS_PAGE]);
  });

  it('reads its rows as vault paths, dropping what is not one', () => {
    expect(markedMeetingsOf([[MEETING], [3], ['/Users/someone/A.md'], []])).toEqual([MEETING]);
  });
});
