import { readImageMarkdown, type ImagePlace, type ImageSize } from '@dfai/domain';
import type { Image, Nodes } from 'mdast';

/*
 * An image's alt text split into its words and its Obsidian size (#568).
 * Which `|` is the size's can only be told from the markdown — `\|`, a code
 * span and `&#124;` all read as a pipe — so each image of a parsed tree is
 * read from its own bytes once (`readImageSizes`) and carries the answer on
 * its `data`. An image made from the editor carries the same, from its node.
 */

/** An image's words and size, as it carries them. */
export interface ImageAlt {
  readonly alt: string | null;
  readonly size: ImageSize | null;
}

interface ImageData {
  imageAlt?: ImageAlt;
}

/** Reads the size of each image in `node` from `body`, the markdown its offsets are into. */
export function readImageSizes(node: Nodes, body: string, place: ImagePlace = OUTSIDE): void {
  if (node.type === 'image') {
    const data = (node.data ?? {}) as ImageData;
    if (data.imageAlt !== undefined) return;
    node.data = { ...node.data, imageAlt: imageAltIn(node, body, place) } as Image['data'];
    return;
  }
  if (!('children' in node)) return;
  const inner = { inCell: place.inCell || node.type === 'tableCell' };
  for (const child of node.children as Nodes[]) readImageSizes(child, body, inner);
}

const OUTSIDE: ImagePlace = { inCell: false };

function imageAltIn(node: Image, body: string, place: ImagePlace): ImageAlt {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (typeof node.alt !== 'string') return { alt: null, size: null };
  if (start === undefined || end === undefined) return { alt: node.alt, size: null };
  return readImageMarkdown({ markdown: body.slice(start, end), alt: node.alt, place });
}

/** An image's words and size: as read from its markdown, or as written from the editor. */
export function imageAltOf(node: Image): ImageAlt {
  const carried = (node.data as ImageData | undefined)?.imageAlt;
  return carried ?? { alt: node.alt ?? null, size: null };
}

/** An image node to write, with its words as its alt text and its size beside them. */
export function imageWithAlt(image: Omit<Image, 'alt' | 'data'>, { alt, size }: ImageAlt): Image {
  return { ...image, alt, data: { imageAlt: { alt, size } } as Image['data'] };
}
