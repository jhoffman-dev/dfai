// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { typesInto } from './row-keys.ts';

/** #109: where a triage key never fires — wherever the key is typed, or another control has the keyboard. */

function placed(html: string): Element {
  document.body.innerHTML = html;
  const target = document.querySelector('[data-target]');
  if (target === null) throw new Error('no target');
  return target;
}

describe('typesInto', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('sleeps in a field: a text box, a date, a select, a text area, anything editable', () => {
    for (const html of [
      '<input data-target>',
      '<input type="date" data-target>',
      '<select data-target></select>',
      '<textarea data-target></textarea>',
    ]) {
      expect(typesInto(placed(html)), html).toBe(true);
    }
    const editable = placed('<div contenteditable="true" data-target></div>') as HTMLElement;
    // jsdom does not work out isContentEditable from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(typesInto(editable)).toBe(true);
  });

  it('sleeps inside a dialog, a menu or a list box, whatever has the focus there', () => {
    for (const role of ['dialog', 'menu', 'listbox']) {
      const html = `<div role="${role}"><button data-target>Pick</button></div>`;
      expect(typesInto(placed(html)), role).toBe(true);
    }
  });

  it('wakes on a row’s own controls: a Done box, a radio, a button, the row itself', () => {
    for (const html of [
      '<input type="checkbox" data-target>',
      '<input type="radio" data-target>',
      '<button data-target>Done</button>',
      '<table><tbody><tr tabindex="-1" data-target><td></td></tr></tbody></table>',
    ]) {
      expect(typesInto(placed(html)), html).toBe(false);
    }
  });
});
