// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EXPORT_PAGE } from '@dfai/domain';
import { remarkMarkdown } from '@dfai/adapters';
import { tauriPdfRenderer } from '@dfai/adapters/tauri';
import { createExportPageRenderer } from '@dfai/ui';

/*
 * #502: the paging script against a table as the export renderer really
 * draws it — read from Markdown, drawn by the reading view's schema — not a
 * hand-written one. jsdom lays nothing out, so each row is given a height
 * and rows stack from the top margin, pushed down by any margin the script
 * gives them or a table holding them.
 */

const { margin: M } = EXPORT_PAGE;

function layOut(): Map<Element, { top: number; height: number }> {
  const leaves = [...document.querySelectorAll('[data-h]')];
  const margined = [...document.querySelectorAll<HTMLElement>('*')].filter(
    (el) => el.style.marginTop !== '',
  );
  const firstLeaf = (el: Element) =>
    el.hasAttribute('data-h') ? el : el.querySelector('[data-h]');
  const placed = new Map<Element, { top: number; height: number }>();
  let y = M;
  for (const leaf of leaves) {
    for (const el of margined) {
      if ((el === leaf || el.contains(leaf)) && firstLeaf(el) === leaf) {
        y += parseFloat(el.style.marginTop);
      }
    }
    const height = Number(leaf.getAttribute('data-h'));
    placed.set(leaf, { top: y, height });
    y += height;
  }
  return placed;
}

function paged(body: string, heights: (body: HTMLElement) => void) {
  document.body.innerHTML = body;
  heights(document.body);
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const placed = layOut();
    const own = placed.get(this);
    const inside = [...placed].filter(([leaf]) => this.contains(leaf)).map(([, box]) => box);
    const top = own?.top ?? inside[0]?.top ?? 0;
    const height = own?.height ?? inside.reduce((sum, box) => sum + box.height, 0);
    return {
      top,
      height,
      bottom: top + height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: top,
      toJSON: () => ({}),
    };
  };
  Object.defineProperty(document.body, 'scrollHeight', {
    configurable: true,
    get: () => {
      const boxes = [...layOut().values()];
      const last = boxes.at(-1);
      return (last === undefined ? M : last.top + last.height) + M;
    },
  });
  new Function(tauriPdfRenderer.pagingScript)();
}

describe('a real exported table across sheets (#502)', () => {
  it('splits at a row, keeping its columns and repeating its header row', () => {
    const rows = Array.from({ length: 30 }, (_, at) => `| Mara ${at} | Plan ${at} |`);
    const markdown = ['| Owner | Task |', '| --- | --- |', ...rows, ''].join('\n');
    const { doc } = remarkMarkdown.parseBody(markdown);
    const html = createExportPageRenderer().bodyHtml(doc);
    expect(html).not.toContain('<thead');
    paged(html, (body) => {
      for (const row of body.querySelectorAll('tr')) row.setAttribute('data-h', '40');
    });

    const tables = [...document.querySelectorAll('table')];
    expect(tables.length).toBeGreaterThan(1);
    const header = (table: Element) => table.querySelector('tr')?.textContent;
    for (const table of tables) expect(header(table)).toBe('OwnerTask');
    const columns = (table: Element) => table.querySelector(':scope > colgroup')?.children.length;
    expect(columns(tables[0]!)).toBe(2);
    expect(columns(tables[1]!)).toBe(2);
    const cells = (table: Element) =>
      [...table.querySelectorAll('td')].map((cell) => cell.textContent ?? '');
    // Every row once, in order: none lost or doubled by the split.
    expect(tables.flatMap(cells)).toEqual(
      Array.from({ length: 30 }, (_, at) => [`Mara ${at}`, `Plan ${at}`]).flat(),
    );
  });
});
