// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { todayMeetingRow, useTodaysMeetings } from './use-todays-meetings.ts';

const VAULT = '/Users/mara/Vault';

const settingsSaying = (frontmatter: string) =>
  fakeVaultFs({
    readNotes: async (paths) =>
      paths.includes('.atlas/settings.md')
        ? [{ path: '.atlas/settings.md', text: `---\n${frontmatter}\n---\n`, modified: 1, size: 1 }]
        : [],
  });

/** The index's answer to the day's events: one meeting with Mara. */
const index = () =>
  fakeIndexPort({
    query: vi.fn(async () => ({
      columns: ['path', 'title', 'key', 'value'],
      rows: [
        ['Calendar/Standup.md', 'Payroll standup', 'date', '2026-10-24T09:00'],
        ['Calendar/Standup.md', 'Payroll standup', 'people', 'People/Mara Quill.md'],
      ],
      truncated: false,
    })),
  });

describe('todayMeetingRow', () => {
  it('draws a meeting’s time as a span, and its people by the names of their notes', () => {
    expect(
      todayMeetingRow({
        path: createVaultPath('Calendar/Standup.md'),
        title: 'Payroll standup',
        start: '09:00',
        end: '09:15',
        people: [createVaultPath('People/Mara Quill.md')],
        companies: [],
        meeting: null,
        unanswered: false,
      }),
    ).toEqual({
      path: 'Calendar/Standup.md',
      title: 'Payroll standup',
      time: '09:00–09:15',
      people: ['Mara Quill'],
      unanswered: false,
    });
  });
});

describe('useTodaysMeetings', () => {
  const read = (frontmatter: string, port = index()) => {
    const hook = renderHook(
      () =>
        useTodaysMeetings({
          fs: settingsSaying(frontmatter),
          markdown: remarkMarkdown,
          index: port,
          vault: VAULT,
          day: '2026-10-24',
          indexReady: true,
        }),
      { wrapper: queryWrapper().wrapper },
    );
    return { hook, port };
  };

  it('reads the day’s meetings for a vault that reads them', async () => {
    const { hook } = read('google_meetings: true');
    await waitFor(() => expect(hook.result.current).toHaveLength(1));
    expect(hook.result.current[0]).toMatchObject({
      title: 'Payroll standup',
      people: ['Mara Quill'],
    });
  });

  it('asks the index nothing for a vault that does not', async () => {
    const { hook, port } = read('theme: dark');
    // The settings read settles before the query would be asked.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hook.result.current).toEqual([]);
    expect(port.query).not.toHaveBeenCalled();
  });
});
