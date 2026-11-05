// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NotHereSettings } from './not-here-settings.tsx';

const LIMITS = [
  { what: 'Syncing by git', why: 'Each save goes to GitHub as a commit of its own instead.' },
  { what: 'Kindle highlights', why: 'They are read by the desktop app.' },
];

describe('NotHereSettings (#670)', () => {
  it('names the section Not available here', () => {
    render(<NotHereSettings limits={LIMITS} />);
    expect(screen.getByRole('heading', { name: 'Not available here' })).toBeDefined();
  });

  it('lists each thing missing with why, in the order it is handed', () => {
    render(<NotHereSettings limits={LIMITS} />);
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Syncing by gitEach save goes to GitHub as a commit of its own instead.',
      'Kindle highlightsThey are read by the desktop app.',
    ]);
  });
});
