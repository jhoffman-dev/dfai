import { describe, expect, it } from 'vitest';
import {
  actionsOn,
  BUDGET_FIXTURES,
  BUDGETED_ACTIONS,
  budgetsPart,
  partLabel,
} from './budgeted-actions.ts';

describe('the fixtures the budgeted actions are done on', () => {
  it('puts every action on exactly one fixture', () => {
    const each = BUDGET_FIXTURES.flatMap((fixture) => actionsOn([fixture]));
    expect([...each].sort()).toEqual([...BUDGETED_ACTIONS].sort());
  });

  it('gives a fixture its actions in the order a run does them', () => {
    expect(actionsOn(['code-note', 'research'])).toEqual([
      'Open the Library (2,000 sources)',
      'Open All highlights (20,000)',
      'Open a note with code in 5 languages',
    ]);
    expect(actionsOn([...BUDGET_FIXTURES])).toEqual([...BUDGETED_ACTIONS]);
    expect(actionsOn(['main'])[0]).toBe('Open a vault');
    expect(actionsOn(['main'])).not.toContain('Open a note with code in 5 languages');
  });
});

describe('the part of the work budgets one run does', () => {
  it('does everything when nothing is named', () => {
    const whole = budgetsPart({});
    expect(whole).toEqual({
      fixtures: ['main', 'research', 'long-note', 'code-note'],
      passes: ['counted', 'timed'],
    });
    expect(budgetsPart({ fixtures: ' ', passes: '' })).toEqual(whole);
    expect(partLabel(whole)).toBe('');
  });

  it('does the fixtures and passes named, in their own order whatever the order given', () => {
    const part = budgetsPart({ fixtures: 'code-note, research', passes: 'timed' });
    expect(part).toEqual({ fixtures: ['research', 'code-note'], passes: ['timed'] });
    expect(partLabel(part)).toBe('research+code-note.timed');
  });

  it('refuses a fixture or a pass it does not know', () => {
    expect(() => budgetsPart({ fixtures: 'main,mian' })).toThrow(
      'PERF_BUDGETS_FIXTURES names mian; it takes main, research, long-note, code-note',
    );
    expect(() => budgetsPart({ passes: 'counted,clocked' })).toThrow(
      /PERF_BUDGETS_PASSES names clocked/,
    );
  });
});
