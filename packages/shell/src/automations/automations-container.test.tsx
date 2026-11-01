// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createIndexStatusStore } from '../index/index-status-store.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import { AutomationsContainer } from './automations-container.tsx';
import { createMeetingSetupStore } from '../meetings/use-meeting-setup.ts';
import { createAutomationsStore } from './automations-store.ts';

describe('the Automations page before its runner has said anything (#419)', () => {
  it('shows the page’s own frame, its history in place, rather than nothing', () => {
    const store = createAutomationsStore();
    const setup = { store: createMeetingSetupStore(), automations: store };
    const wiring = {
      pages: { automations: { store, ports: {}, setup } },
      pane: { indexStatus: createIndexStatusStore(), vault: '/v' },
    } as unknown as PageContainerProps['wiring'];
    const history = { back: 'Today', forward: null, onBack: vi.fn(), onForward: vi.fn() };
    const { container } = render(
      <AutomationsContainer
        wiring={wiring}
        tabId={'tab-1' as PageContainerProps['tabId']}
        chrome={{ history }}
      />,
      { wrapper: queryWrapper().wrapper },
    );
    expect(screen.getByRole('group', { name: 'History' })).toBeTruthy();
    expect(container.querySelector('.panel__body')?.getAttribute('aria-busy')).toBe('true');
  });
});
