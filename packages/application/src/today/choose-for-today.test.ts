import { describe, expect, it } from 'vitest';
import { choiceChange, FocusNotChosenError } from './choose-for-today.ts';

/** #108: a choice for today as a change, judged against the frontmatter the write reads. */
const TODAY = '2026-10-28';

const apply = (choice: Parameters<typeof choiceChange>[0]['choice'], properties: object) => {
  const change = choiceChange({ choice, today: TODAY });
  if (typeof change !== 'function') throw new Error('a choice is judged as it is written');
  return change(properties as Record<string, unknown>);
};

describe('choiceChange', () => {
  it('sets focus to today, or takes it out, over no focus or one day', () => {
    expect(apply('choose', { status: 'next-action' })).toEqual({ focus: TODAY });
    expect(apply('keep', { focus: '2026-10-27' })).toEqual({ focus: TODAY });
    expect(apply('drop', { focus: '2026-10-27' })).toEqual({ focus: null });
    expect(apply('unchoose', { focus: TODAY })).toEqual({ focus: null });
  });

  it('refuses over a focus that is the person’s own, whichever the choice', () => {
    for (const choice of ['choose', 'unchoose', 'keep', 'drop'] as const) {
      expect(() => apply(choice, { focus: 'writing' })).toThrow(FocusNotChosenError);
    }
  });
});
