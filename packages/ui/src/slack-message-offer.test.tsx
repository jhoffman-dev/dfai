// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SlackMessageOffer, type SlackOfferView } from './slack-message-offer.tsx';

/* #105: the offer a pasted Slack link makes, in each of its states. */

const READY: SlackOfferView = {
  state: 'ready',
  author: 'Mara Quill',
  text: 'Can you send the Larkspur renewal by Friday?',
  replies: 2,
  attachments: 1,
  saving: false,
};

function renderWith(view: SlackOfferView) {
  const handlers = {
    onSave: vi.fn(),
    onOpen: vi.fn(),
    onOpenSettings: vi.fn(),
    onDismiss: vi.fn(),
  };
  render(<SlackMessageOffer view={view} {...handlers} />);
  return handlers;
}

const offer = () => screen.getByRole('region', { name: 'Slack message' });
const button = (name: string) => within(offer()).getByRole('button', { name });
const noButton = (name: string) => within(offer()).queryByRole('button', { name });

describe('SlackMessageOffer', () => {
  it('is announced once: its status and alert lines speak, the card itself does not', () => {
    renderWith({ state: 'reading' });
    expect(offer().getAttribute('aria-live')).toBeNull();
    expect(within(offer()).getByRole('status').textContent).toBe('Reading the Slack message…');
  });

  it('while reading, says so and offers nothing to save yet', () => {
    renderWith({ state: 'reading' });
    expect(offer().textContent).toContain('Reading the Slack message…');
    expect(
      within(offer())
        .getAllByRole('button')
        .map((each) => each.textContent),
    ).toEqual(['Dismiss']);
  });

  it('shows who wrote the message, its words and its thread, and saves it as the kind chosen', async () => {
    const { onSave } = renderWith(READY);
    expect(offer().textContent).toContain('Mara Quill');
    expect(screen.getByTestId('slack-offer-text').textContent).toBe(READY.text);
    expect(offer().textContent).toContain('2 replies · 1 file');
    await userEvent.click(button('Save as task'));
    expect(onSave).toHaveBeenLastCalledWith('task');
    await userEvent.click(button('Save as note'));
    expect(onSave).toHaveBeenLastCalledWith('note');
  });

  it('says one reply and no files as such, and nothing for a message alone', () => {
    renderWith({ ...READY, replies: 1, attachments: 0 });
    expect(offer().textContent).toContain('1 reply');
    expect(offer().textContent).not.toContain('file');
  });

  it('cannot be saved twice while a save is under way', () => {
    renderWith({ ...READY, saving: true });
    expect(button('Save as task')).toHaveProperty('disabled', true);
    expect(button('Save as note')).toHaveProperty('disabled', true);
  });

  it('once saved, says where it went and opens it', async () => {
    const { onOpen } = renderWith({ state: 'saved', outcome: 'written', kind: 'task' });
    expect(within(offer()).getByRole('status').textContent).toBe('Saved to the Inbox as a task.');
    expect(noButton('Save as task')).toBeNull();
    await userEvent.click(button('Open'));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('a message already in the vault says so', () => {
    renderWith({ state: 'saved', outcome: 'in-vault', kind: 'note' });
    expect(within(offer()).getByRole('status').textContent).toBe('Already in your vault.');
  });

  it('a problem says what to do, and opens Settings only when the fix is there', async () => {
    const { onOpenSettings, onDismiss } = renderWith({
      state: 'problem',
      problem: 'Slack is not connected on this Mac.',
      fix: 'Connect Slack in Settings → Slack.',
      inSettings: true,
    });
    expect(within(offer()).getByRole('alert').textContent).toBe(
      'Slack is not connected on this Mac.',
    );
    expect(offer().textContent).toContain('Connect Slack in Settings → Slack.');
    await userEvent.click(button('Open Settings'));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    await userEvent.click(button('Dismiss'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('a problem whose fix is not in Settings has no way there', () => {
    renderWith({ state: 'problem', problem: 'x', fix: 'y', inSettings: false });
    expect(within(offer()).getAllByRole('button').length).toBe(1);
    expect(noButton('Open Settings')).toBeNull();
  });
});
