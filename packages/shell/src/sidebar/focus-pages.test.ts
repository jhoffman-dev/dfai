// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { focusPagesWhenDrawn, pagesFocusTarget } from './focus-pages.ts';

/** Frames run by hand, so each test says when the page has moved on. */
function frames() {
  const queued: (() => void)[] = [];
  return {
    nextFrame: (run: () => void) => void queued.push(run),
    run: (count: number) => {
      for (let at = 0; at < count; at += 1) queued.shift()?.();
    },
    pending: () => queued.length,
  };
}

const PAGES = `
  <button aria-controls="sidebar-userSpace">Pages</button>
  <div id="sidebar-userSpace"><div role="tree"><div role="treeitem" tabindex="0">Garden</div></div></div>`;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('pagesFocusTarget', () => {
  it('is the tree’s focusable row, else the heading', () => {
    document.body.innerHTML = PAGES;
    expect(pagesFocusTarget(document)?.textContent).toBe('Garden');
    document.querySelector('[role="tree"]')?.remove();
    expect(pagesFocusTarget(document)?.textContent).toBe('Pages');
  });

  it('is null while Pages is not drawn', () => {
    expect(pagesFocusTarget(document)).toBeNull();
  });
});

describe('focusPagesWhenDrawn', () => {
  it('waits for Pages to be drawn and the palette to go, then focuses its row', () => {
    const clock = frames();
    document.body.innerHTML = '<div class="palette"><input /></div>';
    focusPagesWhenDrawn({ nextFrame: clock.nextFrame });
    clock.run(2);
    expect(document.activeElement).toBe(document.body);

    document.body.innerHTML = `<div class="palette"></div>${PAGES}`;
    clock.run(1);
    expect(document.activeElement).toBe(document.body);

    document.querySelector('.palette')?.remove();
    clock.run(1);
    expect(document.activeElement?.textContent).toBe('Garden');
  });

  it('takes the focus back once if the closing palette hands it elsewhere, then stops', () => {
    const clock = frames();
    document.body.innerHTML = `${PAGES}<button id="opener">Opener</button>`;
    focusPagesWhenDrawn({ nextFrame: clock.nextFrame });
    clock.run(1);
    document.getElementById('opener')?.focus();
    clock.run(1);
    expect(document.activeElement?.textContent).toBe('Garden');
    clock.run(10);
    expect(clock.pending()).toBe(0);
  });

  it('gives up when Pages never appears', () => {
    const clock = frames();
    focusPagesWhenDrawn({ nextFrame: clock.nextFrame });
    clock.run(100);
    expect(clock.pending()).toBe(0);
    expect(document.activeElement).toBe(document.body);
  });
});
