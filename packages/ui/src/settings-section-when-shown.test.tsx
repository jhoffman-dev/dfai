// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { SettingsSectionWhenShown } from './settings-section.tsx';
import { SETTINGS_SECTIONS } from './settings-section-links.ts';

/* #105: a section's body waits until the section is on screen. */

type Watching = (entries: { isIntersecting: boolean }[]) => void;

/** An IntersectionObserver the test says the section is seen by. */
function observerSeeing() {
  const watching: Watching[] = [];
  const disconnect = vi.fn();
  class FakeObserver {
    constructor(callback: Watching) {
      watching.push(callback);
    }
    observe() {}
    disconnect = disconnect;
  }
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  const see = (isIntersecting: boolean) =>
    act(() => {
      for (const callback of watching) callback([{ isIntersecting }]);
    });
  return { see, disconnect };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function Body({ drawn }: { drawn: () => void }) {
  drawn();
  return <p>Slack body</p>;
}

describe('SettingsSectionWhenShown', () => {
  it('is its heading alone, its body never drawn, until it is shown', () => {
    const { see, disconnect } = observerSeeing();
    const drawn = vi.fn();
    render(
      <SettingsSectionWhenShown section={SETTINGS_SECTIONS.slack}>
        <Body drawn={drawn} />
      </SettingsSectionWhenShown>,
    );
    expect(screen.getByRole('region', { name: 'Slack' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Slack' }).id).toBe(SETTINGS_SECTIONS.slack.id);
    see(false);
    expect(screen.queryByText('Slack body')).toBeNull();
    expect(drawn).not.toHaveBeenCalled();

    see(true);
    expect(screen.getByText('Slack body')).toBeTruthy();
    expect(drawn).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
  });

  it('draws its body at once where nothing can tell what is on screen', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    render(
      <SettingsSectionWhenShown section={SETTINGS_SECTIONS.slack}>
        <p>Slack body</p>
      </SettingsSectionWhenShown>,
    );
    expect(screen.getByText('Slack body')).toBeTruthy();
  });
});
