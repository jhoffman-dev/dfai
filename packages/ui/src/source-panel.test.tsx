// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parseDatasource, type Datasource } from '@dfai/domain';
import type { SourceReport } from '@dfai/application';
import { SourcePanel } from './source-panel.tsx';

const sourceFor = (frontmatter: Record<string, unknown>): Datasource => {
  const source = parseDatasource({
    atlas: 'source',
    format: 'csv',
    file: 'feeds/people.csv',
    into: 'People',
    type: 'person',
    ...frontmatter,
  });
  if (source === null) throw new Error('the test asked for a source that does not parse');
  return source;
};

const reportWith = (changes: Partial<SourceReport> = {}): SourceReport => ({
  ran: Date.parse('2026-09-20T09:30:00Z'),
  from: 'feeds/people.csv',
  records: 2,
  created: 2,
  replaced: 0,
  updated: 0,
  missing: 0,
  unkeyed: 0,
  truncated: false,
  error: null,
  ...changes,
});

describe('SourcePanel', () => {
  it('says where the data comes from and where it lands', () => {
    render(
      <SourcePanel source={sourceFor({})} report={null} refreshing={false} onRefresh={() => {}} />,
    );
    expect(screen.getByText('feeds/people.csv')).toBeDefined();
    expect(screen.getByText('CSV')).toBeDefined();
    expect(screen.getByText('person')).toBeDefined();
  });

  it('offers no Refresh where the platform cannot reach the source (#657)', () => {
    render(
      <SourcePanel
        source={sourceFor({ format: 'sqlite', query: 'select 1' })}
        report={null}
        refreshing={false}
      />,
    );
    expect(screen.getByText('SQLITE')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
  });

  it('shows the URL when the source fetches one', () => {
    render(
      <SourcePanel
        source={sourceFor({ file: null, url: 'https://example.test/people.csv' })}
        report={null}
        refreshing={false}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText('https://example.test/people.csv')).toBeDefined();
  });

  it('says a source with no interval refreshes only when asked', () => {
    render(
      <SourcePanel source={sourceFor({})} report={null} refreshing={false} onRefresh={() => {}} />,
    );
    expect(screen.getByText(/only when you ask/)).toBeDefined();
  });

  it('says how often a source with an interval refreshes', () => {
    render(
      <SourcePanel
        source={sourceFor({ interval: 15 })}
        report={null}
        refreshing={false}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText(/every 15 minutes/)).toBeDefined();
  });

  it('says nothing has run yet rather than showing empty counts', () => {
    render(
      <SourcePanel source={sourceFor({})} report={null} refreshing={false} onRefresh={() => {}} />,
    );
    expect(screen.getByText('Not refreshed yet.')).toBeDefined();
  });

  it('refreshes when asked', async () => {
    const onRefresh = vi.fn();
    render(
      <SourcePanel source={sourceFor({})} report={null} refreshing={false} onRefresh={onRefresh} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('cannot be asked twice while it is already refreshing', () => {
    render(<SourcePanel source={sourceFor({})} report={null} refreshing onRefresh={() => {}} />);
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toHaveProperty('disabled', true);
  });

  it('reports what the last refresh did', () => {
    render(
      <SourcePanel
        source={sourceFor({})}
        report={reportWith({ created: 1, replaced: 3, updated: 2 })}
        refreshing={false}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByLabelText('1 created')).toBeDefined();
    expect(screen.getByLabelText('3 refreshed')).toBeDefined();
    expect(screen.getByLabelText('2 kept your text')).toBeDefined();
    expect(screen.getByText(/Last refreshed at/).textContent).toContain('feeds/people.csv');
  });

  it('shows a failure rather than leaving the last good numbers to speak for it', () => {
    render(
      <SourcePanel
        source={sourceFor({})}
        report={reportWith({ created: 0, error: 'the feed answered 404 Not Found' })}
        refreshing={false}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('the feed answered 404 Not Found');
  });

  it('says when a feed was longer than one refresh will write', () => {
    render(
      <SourcePanel
        source={sourceFor({})}
        report={reportWith({ truncated: true })}
        refreshing={false}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('longer than one refresh');
  });

  it('explains that a record that has gone is marked rather than deleted', () => {
    render(
      <SourcePanel
        source={sourceFor({})}
        report={reportWith({ missing: 2 })}
        refreshing={false}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText(/marked, never deleted/)).toBeDefined();
  });

  it('leaves that explanation out when nothing has gone missing', () => {
    render(
      <SourcePanel
        source={sourceFor({})}
        report={reportWith()}
        refreshing={false}
        onRefresh={() => {}}
      />,
    );
    expect(screen.queryByText(/marked, never deleted/)).toBeNull();
  });

  it('shows a SQLite source by its file and query, and offers to choose the file', async () => {
    const onChooseFile = vi.fn();
    render(
      <SourcePanel
        source={sourceFor({ format: 'sqlite', file: 'data/app.db', query: 'SELECT id FROM t' })}
        report={null}
        refreshing={false}
        onRefresh={() => {}}
        onChooseFile={onChooseFile}
      />,
    );

    expect(screen.getByText('SQLITE')).toBeTruthy();
    expect(screen.getByText('SELECT id FROM t')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Choose file…' }));
    expect(onChooseFile).toHaveBeenCalledOnce();
  });

  it('offers no file to choose for a source that is not SQLite', () => {
    render(
      <SourcePanel source={sourceFor({})} report={null} refreshing={false} onRefresh={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });

  it('says when the file is outside the vault', () => {
    render(
      <SourcePanel
        source={sourceFor({ format: 'sqlite', file: '/Users/me/app.db', query: 'SELECT 1' })}
        report={null}
        refreshing={false}
        onRefresh={() => {}}
        outsideVault
      />,
    );
    expect(screen.getByText(/outside the vault/)).toBeTruthy();
  });

  it('says why the file could not be chosen', () => {
    render(
      <SourcePanel
        source={sourceFor({ format: 'sqlite', file: 'data/app.db', query: 'SELECT 1' })}
        report={null}
        refreshing={false}
        onRefresh={() => {}}
        onChooseFile={() => {}}
        fileProblem="unusable file"
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('unusable file');
  });

  it('names the secrets a source sends, and shows its URL by reference', () => {
    render(
      <SourcePanel
        source={sourceFor({
          file: undefined,
          url: 'https://x.test/{{secret:feed}}',
          auth: { secret: 'github' },
        })}
        report={null}
        refreshing={false}
        onRefresh={() => {}}
        secrets={['feed', 'github']}
      />,
    );
    expect(screen.getByText('Sends secrets')).toBeTruthy();
    expect(screen.getByText('github')).toBeTruthy();
    expect(screen.getByText('https://x.test/{{secret:feed}}')).toBeTruthy();
  });
});
