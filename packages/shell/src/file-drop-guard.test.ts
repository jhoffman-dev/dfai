// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { guardStrayFileDrops } from './file-drop-guard.ts';

/** jsdom has no DataTransfer; a drag event carries what the guard reads. */
function drag(
  type: 'dragover' | 'drop' | 'dragenter' | 'dragleave',
  types: string[],
): Event & { dataTransfer: { types: string[]; dropEffect: string } } {
  const event = new Event(type, { bubbles: true, cancelable: true });
  return Object.assign(event, { dataTransfer: { types, dropEffect: 'copy' } });
}

let stop: () => void = () => {};
afterEach(() => stop());

describe('guardStrayFileDrops', () => {
  it('refuses a file dropped outside a drop zone, so the webview never navigates to it', () => {
    stop = guardStrayFileDrops(window);
    const over = drag('dragover', ['Files']);
    const drop = drag('drop', ['Files']);
    document.body.dispatchEvent(over);
    document.body.dispatchEvent(drop);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe('none');
    expect(drop.defaultPrevented).toBe(true);
  });

  it('leaves a drop zone that took the drag its own drop effect', () => {
    stop = guardStrayFileDrops(window);
    const zone = document.createElement('div');
    document.body.append(zone);
    zone.addEventListener('dragover', (event) => event.preventDefault());
    const over = drag('dragover', ['Files']);
    zone.dispatchEvent(over);
    expect(over.dataTransfer.dropEffect).toBe('copy');
    zone.remove();
  });

  it('refuses a link dragged in from a browser outside a drop zone, so the webview never navigates to it', () => {
    // With the host's drag-and-drop off, WebKit's default for a dropped URL on
    // a page that did not take it is to load it — the same app-replacing
    // navigation as a dropped file. A link's drag carries text/uri-list, not Files.
    stop = guardStrayFileDrops(window);
    const over = drag('dragover', ['text/uri-list', 'text/plain']);
    document.body.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe('none');
  });

  it('marks the root while a file is dragged over the window, so a frame cannot take the drop', () => {
    stop = guardStrayFileDrops(window);
    const root = document.documentElement;
    const child = document.createElement('div');
    document.body.append(child);

    document.body.dispatchEvent(drag('dragenter', ['Files']));
    child.dispatchEvent(drag('dragenter', ['Files']));
    document.body.dispatchEvent(drag('dragleave', ['Files']));
    expect(root.dataset['dragging']).toBe('');

    child.dispatchEvent(drag('dragleave', ['Files']));
    expect(root.dataset['dragging']).toBeUndefined();

    document.body.dispatchEvent(drag('dragenter', ['text/plain']));
    expect(root.dataset['dragging']).toBeUndefined();

    document.body.dispatchEvent(drag('dragenter', ['text/uri-list']));
    document.body.dispatchEvent(drag('drop', ['text/uri-list']));
    expect(root.dataset['dragging']).toBeUndefined();
    child.remove();
  });

  it('leaves drags of anything but files alone, and stops when asked', () => {
    stop = guardStrayFileDrops(window);
    const text = drag('drop', ['text/plain']);
    document.body.dispatchEvent(text);
    expect(text.defaultPrevented).toBe(false);

    stop();
    const file = drag('drop', ['Files']);
    document.body.dispatchEvent(file);
    expect(file.defaultPrevented).toBe(false);
  });
});
