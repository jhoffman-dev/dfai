import { describe, expect, it } from 'vitest';
import { entryPointsOffered } from '@dfai/application';
import { DESKTOP_CAPABILITIES, featuresOn, WEB_CAPABILITIES } from '@dfai/domain';
import { offeredFor } from './offered-for.ts';

const desktop = entryPointsOffered(DESKTOP_CAPABILITIES);

describe('offeredFor (#901)', () => {
  it("answers the platform's own object while nothing is switched off", () => {
    expect(offeredFor(desktop, [])).toBe(desktop);
  });

  it('answers what the one gate says with a feature switched off', () => {
    expect(offeredFor(desktop, ['reading'])).toEqual(
      entryPointsOffered(DESKTOP_CAPABILITIES, featuresOn(['reading'])),
    );
    expect(offeredFor(desktop, ['reading']).libraryPages).toBe(false);
  });

  it('answers one object for each off list, whatever array it came in', () => {
    const first = offeredFor(desktop, ['reading']);
    expect(offeredFor(desktop, [...['reading' as const]])).toBe(first);
    expect(offeredFor(desktop, ['reading', 'reading'])).toBe(first);
  });

  it('comes back to the very objects it gave before when a switch is flipped back', () => {
    const off = offeredFor(desktop, ['reading']);
    expect(offeredFor(desktop, [])).toBe(desktop);
    expect(offeredFor(desktop, ['reading'])).toBe(off);
  });

  it("keeps each platform's answers apart", () => {
    const web = entryPointsOffered(WEB_CAPABILITIES);
    expect(offeredFor(web, ['reading'])).not.toBe(offeredFor(desktop, ['reading']));
    expect(offeredFor(web, ['reading']).exportNotes).toBe(true);
    expect(offeredFor(web, ['reading']).claudeChat).toBe(false);
  });
});
