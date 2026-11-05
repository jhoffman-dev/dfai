// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapturePalette, type CaptureOutcome } from './capture-palette.tsx';

/** A capture the test answers by hand, so typing can happen while it is on its way. */
function heldCapture() {
  let answer: (outcome: CaptureOutcome) => void = () => {};
  const onCapture = vi.fn(
    () =>
      new Promise<CaptureOutcome>((resolve) => {
        answer = resolve;
      }),
  );
  return { onCapture, answer: (outcome: CaptureOutcome) => answer(outcome) };
}

const field = () => screen.getByRole('textbox', { name: 'What needs doing' }) as HTMLInputElement;

describe('CapturePalette while a capture is on its way (#672 attack)', () => {
  it.fails('keeps what was typed after Enter when the earlier capture lands', async () => {
    const user = userEvent.setup();
    const held = heldCapture();
    render(<CapturePalette destination="a Task" onCapture={held.onCapture} onClose={() => {}} />);

    await user.type(field(), 'Call Sam{Enter}');
    await user.clear(field());
    await user.type(field(), 'Buy milk');
    await act(async () => held.answer({ captured: true }));

    expect(field().value).toBe('Buy milk');
  });

  it.fails('does not lose a second task whose Enter came while the first was pending', async () => {
    const user = userEvent.setup();
    const held = heldCapture();
    render(<CapturePalette destination="a Task" onCapture={held.onCapture} onClose={() => {}} />);

    await user.type(field(), 'Call Sam{Enter}');
    await user.clear(field());
    await user.type(field(), 'Buy milk{Enter}');
    await act(async () => held.answer({ captured: true }));

    // Either captured (a second call) or still in the field; never neither.
    const kept = field().value === 'Buy milk';
    const captured = held.onCapture.mock.calls.some(([name]) => name === 'Buy milk');
    expect(kept || captured).toBe(true);
  });

  it.fails('says why when the capture itself throws, rather than failing silently', async () => {
    const user = userEvent.setup();
    const onCapture = vi.fn(async (): Promise<CaptureOutcome> => {
      throw new Error('disk full');
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      render(<CapturePalette destination="a Task" onCapture={onCapture} onClose={() => {}} />);
      await user.type(field(), 'Call Sam{Enter}');
      expect(screen.getByRole('alert').textContent).toContain('disk full');
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
