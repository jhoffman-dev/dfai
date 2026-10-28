// @vitest-environment jsdom
/**
 * Adversarial pass on #247 (Performance B, #238): Today's groups and rows are
 * virtualised, and a row to focus that is not in the DOM is `wanted` until it
 * is drawn. Acting on a row scrolled far from the screen must still move the
 * focus to the next row, and a row asked for that never comes must not take
 * the focus later, from wherever the person has put it since.
 *
 * jsdom lays nothing out and cannot scroll: the page's scroller is given a
 * `scrollTop` and a scroll event, which is all the virtualiser reads.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createVaultPath, todayLists, type ReviewTask, type VaultPath } from '@dfai/domain';
import type { TodayReport } from '@dfai/application';
import { TodayPage, type TodayPageProps } from './today-page.tsx';

const TODAY = '2026-10-13';
const NOW = Date.UTC(2026, 9, 13, 15);

const name = (at: number) => `Task ${String(at).padStart(3, '0')}`;

const task = (at: number, project: VaultPath | null = null): ReviewTask => ({
  path: createVaultPath(`Tasks/${name(at)}.md`),
  title: name(at),
  status: 'next-action',
  due: null,
  defer: null,
  waitingOn: '',
  contexts: [],
  project,
  projectTitle: project === null ? null : `Project ${String(at).padStart(3, '0')}`,
  modified: NOW,
});

function report(tasks: readonly ReviewTask[]): TodayReport {
  return {
    ...todayLists({ tasks, projects: [], at: { today: TODAY, now: NOW } }),
    today: TODAY,
    inbox: { count: 0, toFile: 0, toAnswer: 0, more: false },
    truncated: false,
    stalledProjects: 0,
  };
}

const unfiled = (count: number) => Array.from({ length: count }, (_, at) => task(at));
const ownProjects = (count: number) =>
  Array.from({ length: count }, (_, at) => task(at, createVaultPath(`Projects/P${at}.md`)));

function props(today: TodayReport, overrides: Partial<TodayPageProps> = {}): TodayPageProps {
  return {
    today,
    error: null,
    busy: false,
    problem: null,
    view: null,
    onOpen: vi.fn(),
    onOpenInbox: vi.fn(),
    onOpenReview: vi.fn(),
    onOpenDailyNote: vi.fn(),
    onDone: vi.fn(),
    onSetStatus: vi.fn(),
    onDefer: vi.fn(),
    onChoose: vi.fn(),
    ...overrides,
  };
}

const tick = (at: number) => screen.getByRole('checkbox', { name: `Mark ${name(at)} done` });
const focusedLabel = () => document.activeElement?.getAttribute('aria-label') ?? null;

/** Scrolls the page the lists are in, as far as the virtualisers can tell. */
function scrollPageTo(top: number) {
  const scroller = document.querySelector<HTMLElement>('.panel__body');
  if (scroller === null) throw new Error('no scroller');
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: top });
  act(() => {
    fireEvent.scroll(scroller);
  });
}

describe('TodayPage — acting on rows scrolled far from the screen (#247 attack)', () => {
  it('moves the focus to the next row of one group when the ticked row was scrolled away', () => {
    const tasks = unfiled(500);
    const view = render(<TodayPage {...props(report(tasks))} />);
    tick(3).focus();
    scrollPageTo(200_000);

    fireEvent.click(tick(3));
    view.rerender(<TodayPage {...props(report(tasks.filter((_, at) => at !== 3)))} />);

    expect(focusedLabel()).toBe('Mark Task 004 done');
  });

  it('moves the focus into the next project’s group when the ticked row’s group leaves while scrolled away', () => {
    const tasks = ownProjects(300);
    const view = render(<TodayPage {...props(report(tasks))} />);
    tick(3).focus();
    scrollPageTo(500_000);

    fireEvent.click(tick(3));
    view.rerender(<TodayPage {...props(report(tasks.filter((_, at) => at !== 3)))} />);

    expect(focusedLabel()).toBe('Mark Task 004 done');
  });

  it('follows ten ticks in a row down the list, each focusing the next row', () => {
    let tasks = unfiled(500);
    const view = render(<TodayPage {...props(report(tasks))} />);
    tick(0).focus();
    scrollPageTo(200_000);

    for (let at = 0; at < 10; at += 1) {
      fireEvent.click(tick(at));
      tasks = tasks.filter((each) => each.title !== name(at));
      view.rerender(<TodayPage {...props(report(tasks))} />);
      expect(focusedLabel()).toBe(`Mark ${name(at + 1)} done`);
    }
  });

  it('keeps the focused row the same element when a read adds thirty projects’ groups above it', () => {
    const tasks = ownProjects(40).slice(30);
    const view = render(<TodayPage {...props(report(tasks))} />);
    const box = tick(32);
    box.focus();

    view.rerender(<TodayPage {...props(report(ownProjects(40)))} />);

    expect(document.activeElement).toBe(box);
  });

  it('does not later take the focus to a wanted row that left before it was drawn', () => {
    const tasks = unfiled(40);
    const view = render(<TodayPage {...props(report(tasks))} />);
    tick(3).focus();

    // Ticked; the read that comes back has lost the next row too (it was done
    // in another pane), so the row the focus was meant for is never drawn.
    fireEvent.click(tick(3));
    const without = tasks.filter((_, at) => at !== 3 && at !== 4);
    view.rerender(<TodayPage {...props(report(without))} />);

    // The person puts the focus somewhere of their own.
    tick(10).focus();
    expect(focusedLabel()).toBe('Mark Task 010 done');

    // Later the other pane's change is taken back: Task 004 is read again.
    view.rerender(<TodayPage {...props(report(tasks.filter((_, at) => at !== 3)))} />);

    expect(focusedLabel()).toBe('Mark Task 010 done');
  });
});
