// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createVaultPath, todayLists, type ReviewTask } from '@dfai/domain';
import type { TodayReport } from '@dfai/application';
import { TodayPage, type TodayPageProps } from './today-page.tsx';

/** Adversarial pass on #111: whatever a task is called, the page shows it as text. */
const TODAY = '2026-10-13';
const NOW = Date.UTC(2026, 9, 13, 15);

const HOSTILE = [
  '<img src=x onerror="window.__owned = true">',
  '<script>window.__owned = true</script>',
  'Ends a link ]] and opens [[one|two',
  '🧾 Larkspur Payroll 👩‍👩‍👧 run',
  '‮evil.exe‬ שלום مرحبا',
  `Long ${'word '.repeat(600)}`.trim(),
  '&amp; &lt;b&gt; "quoted" \'single\'',
];

const task = (title: string, at: number, fields: Partial<ReviewTask>): ReviewTask => ({
  path: createVaultPath(`Tasks/Task ${at}.md`),
  title,
  status: 'next-action',
  due: null,
  defer: null,
  waitingOn: '',
  contexts: [],
  project: null,
  projectTitle: null,
  modified: NOW,
  ...fields,
});

function pageOf(tasks: readonly ReviewTask[], overrides: Partial<TodayPageProps> = {}) {
  const today: TodayReport = {
    ...todayLists({ tasks, projects: [], at: { today: TODAY, now: NOW } }),
    today: TODAY,
    choosing: true,
    inbox: { count: 0, toFile: 0, toAnswer: 0, more: false },
    truncated: false,
  };
  return render(
    <TodayPage
      today={today}
      error={null}
      busy={false}
      problem={null}
      view={null}
      onOpen={vi.fn()}
      onOpenInbox={vi.fn()}
      onOpenReview={vi.fn()}
      onOpenDailyNote={vi.fn()}
      onDone={vi.fn()}
      onSetStatus={vi.fn()}
      onDefer={vi.fn()}
      onChoose={vi.fn()}
      {...overrides}
    />,
  );
}

describe('TodayPage, with names nobody chose kindly', () => {
  it.each(HOSTILE)('shows a task’s title as written, and makes no element of it: %s', (title) => {
    const { container } = pageOf([task(title, 1, {})]);
    expect(container.textContent).toContain(title);
    expect(container.querySelector('img, script, b, iframe')).toBeNull();
    expect((window as unknown as { __owned?: boolean }).__owned).toBeUndefined();
  });

  it.each(HOSTILE)('shows a project, a person and a context as written: %s', (name) => {
    const { container } = pageOf([
      task('Filed', 1, { project: createVaultPath('Projects/P.md'), projectTitle: name }),
      task('Owed', 2, { status: 'waiting', waitingOn: name }),
      task('Tagged', 3, { status: 'in-progress', contexts: [name] }),
    ]);
    expect(container.textContent?.split(name).length).toBeGreaterThanOrEqual(4);
    expect(container.querySelector('img, script, b, iframe')).toBeNull();
  });

  it('shows a problem as written', () => {
    const [markup = ''] = HOSTILE;
    const { container } = pageOf([task('Plain', 1, {})], { problem: markup });
    expect(container.textContent?.split(markup).length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('img, script')).toBeNull();
  });

  it('gives each of two tasks of one title a row of its own', () => {
    pageOf([task('Call Mara Quill', 1, {}), task('Call Mara Quill', 2, {})]);
    expect(screen.getAllByText('Call Mara Quill')).toHaveLength(2);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });
});
