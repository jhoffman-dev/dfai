import { describe, expect, it } from 'vitest';
import { parseDashboard, QUERY_STOPPED_WORDS } from '@dfai/domain';
import { fakeIndexPort, runWidget } from '@dfai/application';
import { inPlainWords } from './use-dashboard.ts';

const [WIDGET] = parseDashboard({
  atlas: 'dashboard',
  widgets: [{ kind: 'table', type: 'meeting' }],
});

const ranWith = (query: () => Promise<never>) => {
  if (WIDGET === undefined) throw new Error('the test widget does not parse');
  return runWidget({ index: fakeIndexPort({ query }), widget: WIDGET });
};

describe('a dashboard widget the index failed (#919)', () => {
  it('shows a query stopped at the budget in plain words', async () => {
    const result = inPlainWords(await ranWith(() => Promise.reject('interrupted')));
    expect(result.data).toEqual({ shape: 'error', message: QUERY_STOPPED_WORDS });
  });

  it('shows any other failure as the index said it', async () => {
    const result = inPlainWords(
      await ranWith(() => Promise.reject(new Error('no such table: v_x'))),
    );
    expect(result.data).toEqual({ shape: 'error', message: 'no such table: v_x' });
  });
});
