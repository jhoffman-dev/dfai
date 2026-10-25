import { useEffect, useState } from 'react';
import { Node, type Editor } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { ImageLightbox, type LightboxImage } from './image-lightbox.tsx';
import {
  downFromLastImage,
  enterAfterImage,
  imageRoomPlugin,
  upFromFirstImage,
} from './image-room.ts';
import { ImageResizeHandles } from './image-resize.tsx';

export interface ImageOptions {
  /**
   * Turns a markdown image source into something the webview can display.
   * Resolves to null when the image cannot be found or read.
   */
  loadImage: (src: string) => Promise<string | null>;
}

function ImageView({ node, extension, selected, editor, updateAttributes, getPos }: NodeViewProps) {
  const src = String(node.attrs['src'] ?? '');
  const alt = (node.attrs['alt'] as string | null) ?? '';
  // One piece of state, written only from the resolution callbacks: setting state
  // synchronously inside the effect would render twice for every image.
  const [loaded, setLoaded] = useState<{ url: string | null; failed: boolean }>({
    url: null,
    failed: false,
  });
  const { url, failed } = loaded;

  const loadImage = (extension.options as ImageOptions).loadImage;
  const width = typeof node.attrs['width'] === 'number' ? node.attrs['width'] : null;
  // The width a drag is at, drawn but not yet written to the note: that is done once, on release.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const shownWidth = dragWidth ?? width;
  const [viewing, setViewing] = useState<{ images: LightboxImage[]; start: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadImage(src)
      .then((resolved) => {
        if (!cancelled) setLoaded({ url: resolved, failed: resolved === null });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ url: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [loadImage, src]);

  return (
    <NodeViewWrapper as="span" className={selected ? 'image image--selected' : 'image'}>
      {failed ? (
        <span className="image__missing" title={src}>
          Missing image: {src}
        </span>
      ) : (
        url !== null && (
          <img
            className="image__img"
            src={url}
            alt={alt}
            title={src}
            style={shownWidth === null ? undefined : { width: `${shownWidth}px` }}
            onClick={(event) => {
              // Opened wherever the image is shown; a card it is in is not opened as well.
              event.stopPropagation();
              setViewing(imagesAround(editor, getPos()));
            }}
          />
        )
      )}
      {editor.isEditable && url !== null && (
        <ImageResizeHandles
          onDrag={setDragWidth}
          onCancel={() => setDragWidth(null)}
          onRelease={(released) => {
            setDragWidth(null);
            updateAttributes({ width: released, height: null });
          }}
          onReset={() => updateAttributes({ width: null, height: null })}
        />
      )}
      {viewing !== null && (
        <ImageLightbox
          images={viewing.images}
          start={viewing.start}
          loadImage={loadImage}
          onClose={() => setViewing(null)}
          onReturnFocus={() => {
            // Read-only, there is no selection to go back to: the dialog's own restore does.
            const at = getPos();
            if (!editor.isEditable || at === undefined) return false;
            return editor.chain().focus().setNodeSelection(at).run();
          }}
        />
      )}
      {editor.isEditable && (
        <AltTextField
          alt={alt}
          selected={selected}
          onChange={(value) => updateAttributes({ alt: value === '' ? null : value })}
          onDone={() => {
            const at = getPos();
            editor.commands.focus(at === undefined ? undefined : at + node.nodeSize);
          }}
        />
      )}
    </NodeViewWrapper>
  );
}

/** The note's images, in order, and which of them is the one at `at`. */
function imagesAround(
  editor: Editor,
  at: number | undefined,
): { images: LightboxImage[]; start: number } {
  const images: LightboxImage[] = [];
  let start = 0;
  editor.state.doc.descendants((node, position) => {
    if (node.type.name !== 'image') return;
    if (position === at) start = images.length;
    images.push({ src: String(node.attrs['src'] ?? ''), alt: String(node.attrs['alt'] ?? '') });
  });
  return { images, start };
}

/**
 * The selected image's alt text, under it. Each keystroke is written to the
 * node, which moves the editor's selection off the image, so the field stays
 * open for as long as it has the focus rather than for as long as the image is
 * selected. Enter or Escape hands the cursor back, just after the image.
 */
function AltTextField({
  alt,
  selected,
  onChange,
  onDone,
}: {
  alt: string;
  selected: boolean;
  onChange: (alt: string) => void;
  onDone: () => void;
}) {
  const [focused, setFocused] = useState(false);
  if (!selected && !focused) return null;
  return (
    <span className="image__alt" contentEditable={false}>
      <input
        className="image__alt-input"
        aria-label="Alt text"
        placeholder="Describe the image"
        value={alt}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== 'Escape') return;
          event.preventDefault();
          setFocused(false);
          onDone();
        }}
      />
    </span>
  );
}

/**
 * A markdown image. Bytes are fetched through the host rather than loaded by the
 * webview, so displaying an image needs no filesystem access of its own.
 */
export const VaultImage = Node.create<ImageOptions>({
  name: 'image',
  group: 'inline',
  inline: true,
  atom: true,
  draggable: true,

  addOptions() {
    return { loadImage: async () => null };
  },

  addAttributes() {
    return {
      src: { default: '' },
      alt: { default: null },
      title: { default: null },
      // Its width on the page, written `![alt|400](…)` (#568); null is its own size.
      width: {
        default: null,
        parseHTML: (element) => {
          const width = Number(element.getAttribute('width'));
          return Number.isInteger(width) && width > 0 ? width : null;
        },
      },
      // Read from `|400x300` so it is written back as it was; a resize drops it.
      height: { default: null, parseHTML: () => null },
    };
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => enterAfterImage(this.editor),
      ArrowDown: () => downFromLastImage(this.editor),
      ArrowUp: () => upFromFirstImage(this.editor),
    };
  },

  addProseMirrorPlugins() {
    return [imageRoomPlugin()];
  },

  parseHTML() {
    return [{ tag: 'img[src]' }];
  },

  renderHTML({ node }) {
    const width = node.attrs['width'];
    return [
      'img',
      {
        src: String(node.attrs['src'] ?? ''),
        alt: String(node.attrs['alt'] ?? ''),
        ...(typeof width === 'number' && { width: String(width) }),
      },
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});
