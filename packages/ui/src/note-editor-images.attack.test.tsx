// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { undo } from '@tiptap/pm/history';
import { NodeSelection } from '@tiptap/pm/state';
import type { EditorDocument, EditorNode } from '@dfai/domain';
import { NoteEditor } from './note-editor.tsx';

/** Adversarial checks on #568 (PR #570): the viewer, resizing and room after an image, at their edges. */

afterEach(cleanup);

beforeAll(() => {
  const empty = () => DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = empty;
  Element.prototype.scrollIntoView = () => {};
  // jsdom has no pointer capture.
  Element.prototype.setPointerCapture = () => {};
});

const image = (src: string, attrs: Record<string, unknown> = {}): EditorNode => ({
  type: 'image',
  attrs: { src, alt: src.replace('.png', ''), title: null, ...attrs },
});
const paragraph = (...content: EditorNode[]): EditorNode => ({ type: 'paragraph', content });
const words = (text: string): EditorNode => ({ type: 'text', text });

async function editorIn(container: HTMLElement): Promise<Editor> {
  const element = await waitFor(() => {
    const found = container.querySelector('.ProseMirror');
    if (found === null) throw new Error('no editor yet');
    return found;
  });
  return (element as HTMLElement & { editor: Editor }).editor;
}

function renderNote(doc: EditorDocument) {
  const changes: EditorDocument[] = [];
  const view = render(
    <NoteEditor
      doc={doc}
      onChange={(next) => changes.push(next)}
      onFollowLink={() => {}}
      suggestNotes={() => []}
      loadImage={async (src) => `blob:${src}`}
    />,
  );
  return { ...view, changes };
}

const ONE_IMAGE: EditorDocument = {
  type: 'doc',
  content: [paragraph(words('Before.')), paragraph(image('chart.png'))],
};

const pageImage = async (src: string) =>
  waitFor(() => {
    const found = document.querySelector(`.editor img.image__img[src="blob:${src}"]`);
    if (!(found instanceof HTMLImageElement)) throw new Error(`no ${src} yet`);
    return found;
  });

/** The viewer, named by the image it shows. */
const viewer = () => screen.getByRole('dialog');
const zoom = () => screen.getByRole('status', { name: 'Zoom' });

const shownImage = () =>
  waitFor(() => {
    const found = viewer().querySelector('img.lightbox__img');
    if (!(found instanceof HTMLImageElement)) throw new Error('not loaded');
    return found;
  });

function loadAt(shown: HTMLImageElement, width: number, height: number) {
  Object.defineProperty(shown, 'naturalWidth', { value: width, configurable: true });
  Object.defineProperty(shown, 'naturalHeight', { value: height, configurable: true });
  fireEvent.load(shown);
}

const flush = () => act(async () => {});

describe('the image viewer, at its edges', () => {
  it('says an image could not be shown rather than loading forever', async () => {
    render(
      <NoteEditor
        doc={{ type: 'doc', content: [paragraph(image('one.png')), paragraph(image('gone.png'))] }}
        onChange={() => {}}
        onFollowLink={() => {}}
        suggestNotes={() => []}
        loadImage={async (src) => (src === 'gone.png' ? null : `blob:${src}`)}
      />,
    );
    fireEvent.click(await pageImage('one.png'));
    fireEvent.keyDown(viewer(), { key: 'ArrowRight' });
    expect(screen.getByText('2 of 2')).toBeTruthy();
    await flush();
    await flush();

    expect(viewer().textContent).not.toContain('Loading');
  });

  it('keeps an image it has drawn sized when stepping to the same picture again', async () => {
    renderNote({
      type: 'doc',
      content: [
        paragraph(image('chart.png')),
        paragraph(words('Again')),
        paragraph(image('chart.png')),
      ],
    });
    const [first] = document.querySelectorAll('.editor img.image__img');
    fireEvent.click(first ?? (await pageImage('chart.png')));
    loadAt(await shownImage(), 400, 200);
    expect((await shownImage()).style.width).toBe('400px');

    fireEvent.keyDown(viewer(), { key: 'ArrowRight' });
    await flush();
    expect(screen.getByText('2 of 2')).toBeTruthy();
    expect((await shownImage()).style.width).toBe('400px');
  });

  it('keeps a zoomed image on screen however far it is dragged', async () => {
    renderNote(ONE_IMAGE);
    fireEvent.click(await pageImage('chart.png'));
    const shown = await shownImage();
    loadAt(shown, 800, 600);
    fireEvent.keyDown(viewer(), { key: '=', metaKey: true });
    expect(zoom().textContent).toBe('125%');

    const stage = viewer().querySelector('.lightbox__stage')!;
    fireEvent.pointerDown(stage, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: 100_000, clientY: -100_000, pointerId: 1 });
    fireEvent.pointerUp(stage, { clientX: 100_000, clientY: -100_000, pointerId: 1 });

    const moved = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(shown.style.transform);
    expect(moved).not.toBeNull();
    // Drawn 1000 by 750: panned further than that, none of it is left on screen.
    expect(Math.abs(Number(moved![1]))).toBeLessThanOrEqual(1000);
    expect(Math.abs(Number(moved![2]))).toBeLessThanOrEqual(750);
  });

  it('closes, without an error, when the note it was opened from is replaced', async () => {
    const { rerender } = renderNote(ONE_IMAGE);
    fireEvent.click(await pageImage('chart.png'));
    expect(viewer()).toBeTruthy();
    const other: EditorDocument = { type: 'doc', content: [paragraph(words('Another note.'))] };

    rerender(
      <NoteEditor
        doc={other}
        onChange={() => {}}
        onFollowLink={() => {}}
        suggestNotes={() => []}
        loadImage={async (src) => `blob:${src}`}
      />,
    );
    await flush();

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('room after an image, in the blocks an image can be in', () => {
  const selectImage = (editor: Editor, src: string) => {
    let at = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'image' && node.attrs['src'] === src) at = position;
    });
    act(() => {
      editor.view.dispatch(
        editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at)),
      );
    });
  };
  const press = (editor: Editor, key: string) =>
    act(() => {
      editor.view.someProp('handleKeyDown', (handle) =>
        handle(editor.view, new KeyboardEvent('keydown', { key })),
      );
    });
  const imageCount = (editor: Editor) => {
    let count = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image') count += 1;
    });
    return count;
  };
  const item = (type: string, ...content: EditorNode[]): EditorNode => ({
    type,
    ...(type === 'taskItem' && { attrs: { checked: false } }),
    content,
  });

  it.each([
    ['a bullet list', 'bulletList', 'listItem'],
    ['an ordered list', 'orderedList', 'listItem'],
    ['a task list', 'taskList', 'taskItem'],
  ])(
    'Enter on a selected image in %s keeps it and splits the item after it',
    async (_label, list, listItem) => {
      const { container } = renderNote({
        type: 'doc',
        content: [{ type: list, content: [item(listItem, paragraph(image('chart.png')))] }],
      });
      const editor = await editorIn(container);
      selectImage(editor, 'chart.png');
      press(editor, 'Enter');

      expect(imageCount(editor)).toBe(1);
      const items = editor.state.doc.child(0);
      expect(items.childCount).toBe(2);
      expect(items.child(0).firstChild?.firstChild?.type.name).toBe('image');
      expect(items.child(1).textContent).toBe('');
      const { $from } = editor.state.selection;
      expect($from.node($from.depth - 1)).toBe(items.child(1));
    },
  );

  it('Enter on a selected image in a callout keeps it and starts a new empty line inside the callout', async () => {
    const { container } = renderNote({
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { kind: 'note', title: null, fold: null },
          content: [paragraph(image('chart.png'))],
        },
      ],
    });
    const editor = await editorIn(container);
    selectImage(editor, 'chart.png');
    press(editor, 'Enter');

    const callout = editor.state.doc.child(0);
    expect(imageCount(editor)).toBe(1);
    expect(callout.child(0).firstChild?.type.name).toBe('image');
    expect(callout.childCount).toBe(2);
    expect(callout.child(1).type.name).toBe('paragraph');
    expect(callout.child(1).content.size).toBe(0);
    const { $from } = editor.state.selection;
    expect($from.parent).toBe(callout.child(1));
  });

  it('Enter on a selected image in a list keeps its caption', async () => {
    const { container } = renderNote({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [item('listItem', paragraph(image('chart.png'), words(' cap')))],
        },
      ],
    });
    const editor = await editorIn(container);
    selectImage(editor, 'chart.png');
    press(editor, 'Enter');

    expect(imageCount(editor)).toBe(1);
    expect(editor.state.doc.textContent).toBe(' cap');
  });

  it('Enter on a selected image in a quote puts the caret after it, as at the top level', async () => {
    const { container } = renderNote({
      type: 'doc',
      content: [{ type: 'blockquote', content: [paragraph(image('chart.png'))] }],
    });
    const editor = await editorIn(container);
    selectImage(editor, 'chart.png');
    press(editor, 'Enter');

    const quote = editor.state.doc.child(0);
    expect(quote.child(0).firstChild?.type.name).toBe('image');
    expect(editor.state.selection.$from.parent).not.toBe(quote.child(0));
  });

  it('undo after Enter on the last image keeps the image and the line after it', async () => {
    const { container } = renderNote(ONE_IMAGE);
    const editor = await editorIn(container);
    selectImage(editor, 'chart.png');
    press(editor, 'Enter');
    expect(editor.state.doc.childCount).toBe(3);

    act(() => {
      undo(editor.state, editor.view.dispatch);
    });
    // Enter made no line, so there is none to take away: the line kept after the image stays.
    expect(editor.state.doc.childCount).toBe(3);
    expect(imageCount(editor)).toBe(1);
    expect(editor.state.doc.child(1).firstChild?.type.name).toBe('image');
  });

  it('a shift-click below a note that ends in an image extends the selection, adding no line', async () => {
    const { container } = renderNote(ONE_IMAGE);
    const editor = await editorIn(container);
    selectImage(editor, 'chart.png');
    const lines = editor.state.doc.childCount;

    fireEvent.mouseDown(editor.view.dom, { button: 0, clientY: 140, shiftKey: true });

    expect(editor.state.doc.childCount).toBe(lines);
  });
});

describe('resizing an image at its edges', () => {
  it('a drag the pointer gives up on (pointercancel) leaves the width as it was', async () => {
    const { container, changes } = renderNote({
      type: 'doc',
      content: [paragraph(image('chart.png', { width: 200 }))],
    });
    await editorIn(container);
    const before = changes.length;
    const img = await pageImage('chart.png');
    img.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 100 });
    const handle = img.parentElement!.querySelector('.image__handle--right')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 300, pointerId: 1 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });

    expect(changes.length - before).toBe(0);
    expect((await pageImage('chart.png')).style.width).toBe('200px');
  });

  it('a drag released at the width it started at writes nothing', async () => {
    const { container, changes } = renderNote({
      type: 'doc',
      content: [paragraph(image('chart.png', { width: 200, height: 150 }))],
    });
    await editorIn(container);
    const before = changes.length;
    const img = await pageImage('chart.png');
    img.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 150 });
    const handle = img.parentElement!.querySelector('.image__handle--right')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 140, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 100, pointerId: 1 });

    expect(changes.length - before).toBe(0);
  });
});

describe('a note with 200 images', () => {
  it('loads each image once, and a resize of one loads none again', async () => {
    const loads: string[] = [];
    const content = Array.from({ length: 200 }, (_, at) => paragraph(image(`p${at}.png`)));
    const { container } = render(
      <NoteEditor
        doc={{ type: 'doc', content }}
        onChange={() => {}}
        onFollowLink={() => {}}
        suggestNotes={() => []}
        loadImage={async (src) => {
          loads.push(src);
          return `blob:${src}`;
        }}
      />,
    );
    await editorIn(container);
    const img = await pageImage('p100.png');
    expect(new Set(loads).size).toBe(200);
    expect(loads).toHaveLength(200);

    img.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 300, height: 100 });
    const handle = img.parentElement!.querySelector('.image__handle--right')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 150, pointerId: 1 });
    await flush();

    expect((await pageImage('p100.png')).style.width).toBe('350px');
    expect(loads).toHaveLength(200);
  });
});
