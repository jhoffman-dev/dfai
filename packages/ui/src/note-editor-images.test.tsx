// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { undo } from '@tiptap/pm/history';
import { NodeSelection } from '@tiptap/pm/state';
import type { EditorDocument, EditorNode } from '@dfai/domain';
import { NoteEditor } from './note-editor.tsx';

/** #568: an image opens larger in a viewer, resizes on the page, and leaves room after it. */

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

describe('the image viewer', () => {
  it('opens on a click on the image, showing that image, named by its alt text', async () => {
    renderNote(ONE_IMAGE);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(await pageImage('chart.png'));

    expect(screen.getByRole('dialog', { name: 'chart' })).toBeTruthy();
    await waitFor(() =>
      expect(viewer().querySelector('img.lightbox__img')?.getAttribute('src')).toBe(
        'blob:chart.png',
      ),
    );
    expect(zoom().textContent).toBe('100%');
  });

  it('zooms in with ⌘+, out with ⌘−, and back to fit with ⌘0', async () => {
    renderNote(ONE_IMAGE);
    fireEvent.click(await pageImage('chart.png'));

    fireEvent.keyDown(viewer(), { key: '=', metaKey: true });
    expect(zoom().textContent).toBe('125%');
    fireEvent.keyDown(viewer(), { key: '+', metaKey: true });
    expect(zoom().textContent).toBe('150%');
    fireEvent.keyDown(viewer(), { key: '-', metaKey: true });
    expect(zoom().textContent).toBe('125%');
    fireEvent.keyDown(viewer(), { key: '0', metaKey: true });
    expect(zoom().textContent).toBe('100%');
  });

  it('zooms with the bar’s buttons and toggles on a double-click', async () => {
    renderNote(ONE_IMAGE);
    fireEvent.click(await pageImage('chart.png'));

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(zoom().textContent).toBe('125%');
    fireEvent.doubleClick(viewer().querySelector('.lightbox__stage')!);
    expect(zoom().textContent).toBe('100%');
    fireEvent.doubleClick(viewer().querySelector('.lightbox__stage')!);
    expect(zoom().textContent).toBe('200%');
  });

  it('draws the image at its natural size times the zoom', async () => {
    renderNote(ONE_IMAGE);
    fireEvent.click(await pageImage('chart.png'));
    const shown = await waitFor(() => {
      const found = viewer().querySelector('img.lightbox__img');
      if (!(found instanceof HTMLImageElement)) throw new Error('not loaded');
      return found;
    });
    Object.defineProperty(shown, 'naturalWidth', { value: 400 });
    Object.defineProperty(shown, 'naturalHeight', { value: 200 });
    fireEvent.load(shown);
    expect(shown.style.width).toBe('400px');

    fireEvent.keyDown(viewer(), { key: '=', metaKey: true });
    expect(shown.style.width).toBe('500px');
    expect(shown.style.height).toBe('250px');
  });

  it('closes on Escape and hands the focus back to the image, selected', async () => {
    const { container } = renderNote(ONE_IMAGE);
    const editor = await editorIn(container);
    fireEvent.click(await pageImage('chart.png'));
    expect(viewer()).toBeTruthy();

    fireEvent.keyDown(viewer(), { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(editor.isFocused).toBe(true));
    const { selection } = editor.state;
    expect(selection instanceof NodeSelection && selection.node.type.name).toBe('image');
  });

  it('closes on a click beside the image, but not on the image', async () => {
    renderNote(ONE_IMAGE);
    fireEvent.click(await pageImage('chart.png'));
    const shown = await waitFor(() => {
      const found = viewer().querySelector('img.lightbox__img');
      if (found === null) throw new Error('not loaded');
      return found;
    });

    fireEvent.click(shown);
    expect(viewer()).toBeTruthy();
    fireEvent.click(viewer().querySelector('.lightbox__stage')!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('steps through the note’s images with the arrow keys', async () => {
    renderNote({
      type: 'doc',
      content: [paragraph(image('one.png')), paragraph(words('Then')), paragraph(image('two.png'))],
    });
    fireEvent.click(await pageImage('two.png'));
    expect(screen.getByText('2 of 2')).toBeTruthy();

    fireEvent.keyDown(viewer(), { key: 'ArrowLeft' });
    expect(screen.getByText('1 of 2')).toBeTruthy();
    await waitFor(() =>
      expect(viewer().querySelector('img.lightbox__img')?.getAttribute('src')).toBe('blob:one.png'),
    );
    fireEvent.keyDown(viewer(), { key: 'ArrowLeft' });
    expect(screen.getByText('1 of 2')).toBeTruthy();
  });
});

describe('resizing an image on the page', () => {
  /** Drags the image's right handle by `dx` pixels from a width of `from`. */
  async function dragRightHandle({
    from,
    dx,
    column,
  }: {
    from: number;
    dx: number;
    column: number;
  }) {
    const img = await pageImage('chart.png');
    img.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: from, height: 100 });
    Object.defineProperty(img.closest('p')!, 'clientWidth', { value: column, configurable: true });
    const handle = img.parentElement!.querySelector('.image__handle--right')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 100 + dx, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 100 + dx, pointerId: 1 });
    return img;
  }

  const imageAttrs = (editor: Editor) => {
    let found: Record<string, unknown> = {};
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image') found = node.attrs;
    });
    return found;
  };

  it('draws the width as it is dragged and writes it once, on release', async () => {
    const { container, changes } = renderNote(ONE_IMAGE);
    const editor = await editorIn(container);
    const before = changes.length;

    const img = await pageImage('chart.png');
    img.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 300, height: 100 });
    const handle = img.parentElement!.querySelector('.image__handle--right')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 160, pointerId: 1 });
    expect(img.style.width).toBe('360px');
    expect(changes.length - before).toBe(0);
    fireEvent.pointerMove(handle, { clientX: 220, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 220, pointerId: 1 });

    expect((await pageImage('chart.png')).style.width).toBe('420px');
    expect(imageAttrs(editor)).toMatchObject({ width: 420, height: null });
    expect(changes.length - before).toBe(1);
  });

  it('is held to the column and to the narrowest width', async () => {
    const { container } = renderNote(ONE_IMAGE);
    const editor = await editorIn(container);
    await dragRightHandle({ from: 300, dx: 900, column: 640 });
    expect(imageAttrs(editor)['width']).toBe(640);
    await dragRightHandle({ from: 640, dx: -900, column: 640 });
    expect(imageAttrs(editor)['width']).toBe(64);
  });

  it('is put back by one undo', async () => {
    const { container } = renderNote({
      type: 'doc',
      content: [paragraph(image('chart.png', { width: 200 }))],
    });
    const editor = await editorIn(container);
    await dragRightHandle({ from: 200, dx: 100, column: 700 });
    expect(imageAttrs(editor)['width']).toBe(300);

    act(() => {
      undo(editor.state, editor.view.dispatch);
    });
    expect(imageAttrs(editor)['width']).toBe(200);
  });

  it('goes back to its own size on a double-click on a handle', async () => {
    const { container } = renderNote({
      type: 'doc',
      content: [paragraph(image('chart.png', { width: 200, height: 100 }))],
    });
    const editor = await editorIn(container);
    const img = await pageImage('chart.png');
    expect(img.style.width).toBe('200px');

    fireEvent.doubleClick(img.parentElement!.querySelector('.image__handle--left')!);

    expect(imageAttrs(editor)).toMatchObject({ width: null, height: null });
    await waitFor(async () => expect((await pageImage('chart.png')).style.width).toBe(''));
  });
});

describe('room to type beside an image', () => {
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
  const blocks = (editor: Editor) =>
    editor.state.doc.content.content.map((block) => `${block.type.name}:${block.textContent}`);
  const caretBlock = (editor: Editor) => editor.state.selection.$from.index(0);
  const press = (editor: Editor, key: string) =>
    act(() => {
      editor.view.someProp('handleKeyDown', (handle) =>
        handle(editor.view, new KeyboardEvent('keydown', { key })),
      );
    });

  it('Enter on the last image makes an empty line after it, with the caret there', async () => {
    const { container } = renderNote(ONE_IMAGE);
    const editor = await editorIn(container);
    selectImage(editor, 'chart.png');
    press(editor, 'Enter');

    expect(blocks(editor)).toEqual(['paragraph:Before.', 'paragraph:', 'paragraph:']);
    expect(editor.state.doc.child(1).firstChild?.type.name).toBe('image');
    expect(caretBlock(editor)).toBe(2);
    expect(editor.state.selection.empty).toBe(true);
  });

  it('Enter moves to an empty line already after the image rather than making another', async () => {
    const { container } = renderNote({
      type: 'doc',
      content: [paragraph(image('chart.png')), { type: 'paragraph' }, paragraph(words('After'))],
    });
    const editor = await editorIn(container);
    selectImage(editor, 'chart.png');
    press(editor, 'Enter');

    expect(blocks(editor)).toEqual(['paragraph:', 'paragraph:', 'paragraph:After']);
    expect(caretBlock(editor)).toBe(1);
  });

  it('Enter on an image with words after it splits the line after the image', async () => {
    const { container } = renderNote({
      type: 'doc',
      content: [paragraph(image('chart.png'), words(' a caption'))],
    });
    const editor = await editorIn(container);
    selectImage(editor, 'chart.png');
    press(editor, 'Enter');

    expect(blocks(editor)).toEqual(['paragraph:', 'paragraph: a caption']);
    expect(caretBlock(editor)).toBe(1);
  });

  it('↓ on an image in the note’s last line makes a line after it', async () => {
    const { container } = renderNote(ONE_IMAGE);
    const editor = await editorIn(container);
    selectImage(editor, 'chart.png');
    press(editor, 'ArrowDown');

    expect(blocks(editor)).toHaveLength(3);
    expect(caretBlock(editor)).toBe(2);
  });

  it('↓ on an image with a line after it leaves the note as it is', async () => {
    const { container } = renderNote({
      type: 'doc',
      content: [paragraph(image('chart.png')), paragraph(words('After'))],
    });
    const editor = await editorIn(container);
    selectImage(editor, 'chart.png');
    press(editor, 'ArrowDown');
    expect(blocks(editor)).toEqual(['paragraph:', 'paragraph:After']);
  });

  it('↑ on an image at the very top makes a line before it', async () => {
    const { container } = renderNote({
      type: 'doc',
      content: [paragraph(image('chart.png')), paragraph(words('After'))],
    });
    const editor = await editorIn(container);
    selectImage(editor, 'chart.png');
    press(editor, 'ArrowUp');

    expect(blocks(editor)).toEqual(['paragraph:', 'paragraph:', 'paragraph:After']);
    expect(editor.state.doc.child(1).firstChild?.type.name).toBe('image');
    expect(caretBlock(editor)).toBe(0);
  });

  it('a click below a note that ends in an image goes to a new line after it', async () => {
    const { container } = renderNote(ONE_IMAGE);
    const editor = await editorIn(container);
    const last = container.querySelector('.ProseMirror > p:last-child')!;
    last.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 100 });

    fireEvent.mouseDown(editor.view.dom, { button: 0, clientY: 140 });

    expect(blocks(editor)).toEqual(['paragraph:Before.', 'paragraph:', 'paragraph:']);
    expect(caretBlock(editor)).toBe(2);
  });

  it('a click on the image line itself is left to the editor', async () => {
    const { container } = renderNote(ONE_IMAGE);
    const editor = await editorIn(container);
    const last = container.querySelector('.ProseMirror > p:last-child')!;
    last.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 100 });

    fireEvent.mouseDown(editor.view.dom, { button: 0, clientY: 60 });
    expect(blocks(editor)).toHaveLength(2);
  });
});
