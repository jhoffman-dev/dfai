// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { PreloadAfterStart } from './preload-after-start.tsx';

describe('PreloadAfterStart', () => {
  it('starts the preload only once the tree has committed, and draws nothing', () => {
    const preload = vi.fn(() => Promise.resolve());
    let committedFirst = false;
    function Shell() {
      return <p ref={() => void (committedFirst = preload.mock.calls.length === 0)}>shell</p>;
    }
    const { container } = render(
      <>
        <Shell />
        <PreloadAfterStart preload={preload} />
      </>,
    );
    expect(committedFirst).toBe(true);
    expect(preload).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('shell');
  });

  it('does not start it again when its parent draws again', () => {
    const preload = vi.fn(() => Promise.resolve());
    const { rerender } = render(<PreloadAfterStart preload={preload} />);
    rerender(<PreloadAfterStart preload={preload} />);
    expect(preload).toHaveBeenCalledTimes(1);
  });
});
