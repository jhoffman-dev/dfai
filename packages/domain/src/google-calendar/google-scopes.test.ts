import { describe, expect, it } from 'vitest';
import {
  coversScopes,
  grantsUse,
  scopesWith,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_SCOPES_BY_USE,
} from './index.ts';

const BLOCKS = 'https://www.googleapis.com/auth/calendar.app.created';
const READ_EVENTS = 'https://www.googleapis.com/auth/calendar.events.readonly';

describe('GOOGLE_SCOPES_BY_USE (ADR-0046)', () => {
  it('asks for the narrowest scope each use needs, and reads meetings without writing', () => {
    expect(GOOGLE_SCOPES_BY_USE).toEqual({
      blocks: [BLOCKS],
      meetings: [READ_EVENTS],
      export: ['https://www.googleapis.com/auth/drive.file'],
    });
    expect(GOOGLE_CALENDAR_SCOPES).toEqual([BLOCKS]);
    expect(GOOGLE_DRIVE_FILE_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
  });
});

describe('scopesWith', () => {
  it('adds what a use needs on top of what was granted, keeping every scope before', () => {
    expect(scopesWith([BLOCKS], 'meetings')).toEqual([BLOCKS, READ_EVENTS]);
    expect(scopesWith([BLOCKS, READ_EVENTS], 'export')).toEqual([
      BLOCKS,
      READ_EVENTS,
      GOOGLE_DRIVE_FILE_SCOPE,
    ]);
  });

  it('asks for nothing when the use is already granted, so no consent screen is shown', () => {
    expect(scopesWith([READ_EVENTS, BLOCKS], 'meetings')).toBeNull();
    expect(scopesWith([GOOGLE_DRIVE_FILE_SCOPE, BLOCKS], 'export')).toBeNull();
  });

  it('starts from nothing for a vault with no sign-in yet', () => {
    expect(scopesWith([], 'blocks')).toEqual([BLOCKS]);
  });
});

describe('grantsUse', () => {
  it('is true only when every scope of the use was granted', () => {
    expect(grantsUse([BLOCKS, READ_EVENTS], 'meetings')).toBe(true);
    expect(grantsUse([BLOCKS], 'meetings')).toBe(false);
    expect(grantsUse([], 'blocks')).toBe(false);
  });
});

describe('coversScopes', () => {
  it('needs every scope, not some of them', () => {
    expect(coversScopes([BLOCKS, READ_EVENTS], [BLOCKS, READ_EVENTS])).toBe(true);
    expect(coversScopes([BLOCKS], [BLOCKS, READ_EVENTS])).toBe(false);
    expect(coversScopes([], [])).toBe(true);
  });
});
