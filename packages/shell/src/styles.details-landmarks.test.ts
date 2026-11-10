import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #815: when a toast or a notice goes while its details are read, the focus
 * is handed to the toasts' column or to the notices. Either may be empty by
 * then — a box of no size — so each shows the focus ring the buttons show,
 * and has a box to show it on while it is empty (WCAG 2.4.7).
 */

const css = readFileSync(
  fileURLToPath(new URL('./styles/event-details.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the block with exactly this selector list. */
function blockOf(selector: string): Map<string, string> {
  const found = new RegExp(
    `(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*{([^}]*)}`,
  ).exec(css);
  if (found === null) throw new Error(`no block ${selector}`);
  const declared = new Map<string, string>();
  for (const match of (found[1] ?? '').matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
    declared.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  return declared;
}

describe('where a lost focus is sent — the toasts’ column and the notices', () => {
  it('shows the focus on each with the ring the buttons show', () => {
    const focused = blockOf('.toast-stack:focus-visible,\n.notices:focus-visible');
    expect(focused.get('box-shadow')).toBe('var(--ring)');
    expect(focused.get('outline')).toBe('none');
  });

  it('gives the empty column a box at the toasts’ corner to show the ring on', () => {
    const empty = blockOf('.toast-stack:empty:focus-visible');
    expect(Number.parseInt(empty.get('min-height') ?? '0', 10)).toBeGreaterThanOrEqual(4);
    expect(Number.parseInt(empty.get('min-width') ?? '0', 10)).toBeGreaterThanOrEqual(24);
  });

  it('gives the empty notices a line across the window to show the ring on', () => {
    const empty = blockOf('.notices:empty:focus-visible');
    expect(Number.parseInt(empty.get('min-height') ?? '0', 10)).toBeGreaterThanOrEqual(2);
  });
});
