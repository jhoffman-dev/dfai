import { describe, expect, it } from 'vitest';
import {
  canStepBack,
  canStepForward,
  standOn,
  startTrail,
  stepBack,
  stepForward,
  stepTo,
  trailMarkdown,
  trailNoteName,
  trailStep,
  type Trail,
} from './trail.ts';

const walk = (...paths: string[]): Trail =>
  paths.slice(1).reduce(stepTo, startTrail(paths[0] as string));

describe('a trail', () => {
  it('starts and stands at its first note, with nowhere to step back or forward', () => {
    const trail = startTrail('A.md');
    expect(trailStep(trail)).toBe('A.md');
    expect(canStepBack(trail)).toBe(false);
    expect(canStepForward(trail)).toBe(false);
    expect(stepBack(trail)).toBe(trail);
    expect(stepForward(trail)).toBe(trail);
  });

  it('steps forward to each note followed, in order', () => {
    const trail = walk('A.md', 'B.md', 'C.md');
    expect(trail).toEqual({ steps: ['A.md', 'B.md', 'C.md'], at: 2 });
  });

  it('stays put when stepping to the note it stands on', () => {
    const trail = walk('A.md', 'B.md');
    expect(stepTo(trail, 'B.md')).toBe(trail);
  });

  it('steps back and forward along the steps walked, keeping them', () => {
    const back = stepBack(stepBack(walk('A.md', 'B.md', 'C.md')));
    expect(back).toEqual({ steps: ['A.md', 'B.md', 'C.md'], at: 0 });
    expect(canStepForward(back)).toBe(true);
    expect(trailStep(stepForward(back))).toBe('B.md');
  });

  it('follows the next step already walked without branching', () => {
    const back = stepBack(walk('A.md', 'B.md', 'C.md'));
    expect(stepTo(back, 'C.md')).toEqual({ steps: ['A.md', 'B.md', 'C.md'], at: 2 });
  });

  it('branches from an earlier step: the steps after it are dropped', () => {
    const back = stepBack(stepBack(walk('A.md', 'B.md', 'C.md')));
    expect(stepTo(back, 'D.md')).toEqual({ steps: ['A.md', 'D.md'], at: 1 });
  });

  it('stands on any step walked, and ignores a step outside the trail', () => {
    const trail = walk('A.md', 'B.md', 'C.md');
    expect(standOn(trail, 0).at).toBe(0);
    expect(standOn(trail, 3)).toBe(trail);
    expect(standOn(trail, -1)).toBe(trail);
    expect(standOn(trail, 1.5)).toBe(trail);
  });
});

describe('a saved trail', () => {
  it('is named after the note it starts from', () => {
    expect(trailNoteName('Payroll ideas')).toBe('Trail from Payroll ideas');
  });

  it('is a numbered list of links, one step a line, in the order walked', () => {
    expect(trailMarkdown(['Payroll ideas', 'Projects/Budget', 'Mara Quill'])).toBe(
      '1. [[Payroll ideas]]\n2. [[Projects/Budget]]\n3. [[Mara Quill]]\n',
    );
  });
});
