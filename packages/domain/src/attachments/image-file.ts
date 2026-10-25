import { cleanEntryName } from '../vault/new-note.ts';

/**
 * What a webview is told an image file is, by its extension — for showing any
 * image a note points at, including kinds that cannot be embedded from here.
 */
const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  apng: 'image/apng',
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

/**
 * The kinds of image that can be put into a note. HEIC is on the list because
 * a Mac's photos are HEIC; whether the webview can actually draw one is asked
 * of it before the file is written, and one it cannot is refused then.
 */
export const EMBEDDABLE_IMAGE_EXTENSIONS: readonly string[] = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'heic',
  'heif',
];

/**
 * The largest image a note takes, 20 MiB: well past any screenshot, well under
 * the host's limit. Written as a literal so its type is the number itself, which
 * the API contract hands to clients that keep their own copy (ApiMaxImageBytes).
 */
export const MAX_IMAGE_BYTES = 20_971_520;

/** What a file picker offers when it is picking an image for a note. */
export const IMAGE_PICKER_ACCEPT = EMBEDDABLE_IMAGE_EXTENSIONS.map((ext) => `.${ext}`).join(',');

/** The MIME type to show `path` as; a generic one when its extension is not an image. */
export function imageMimeType(path: string): string {
  return IMAGE_MIME_TYPES[extensionOf(path)] ?? 'application/octet-stream';
}

/** An image on its way into a note, as it arrived: dropped, picked or pasted. */
export interface IncomingImage {
  /** The file's own name; a pasted screenshot's is empty or a generic `image.png`. */
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  /** A paste names its image generically; a dropped or picked file is named for real. */
  readonly origin: 'clipboard' | 'file';
}

export type ImageCheck =
  | { readonly kind: 'accepted'; readonly extension: string }
  | { readonly kind: 'refused'; readonly message: string };

/**
 * Whether an image may go into a note, and as what kind.
 *
 * The extension decides, since that is what the file will be read back as;
 * the MIME type stands in only when the name has none a note can take — a
 * pasted image is often called nothing at all.
 */
export function checkIncomingImage(image: IncomingImage): ImageCheck {
  const extension = embeddableExtension(image);
  const shown = image.name === '' ? 'The pasted image' : `“${image.name}”`;
  if (extension === null) {
    return {
      kind: 'refused',
      message: `${shown} is not an image a note can hold. Use PNG, JPEG, GIF, WebP, SVG or HEIC.`,
    };
  }
  if (image.size === 0) return { kind: 'refused', message: `${shown} is empty.` };
  if (image.size > MAX_IMAGE_BYTES) {
    const megabytes = (image.size / 1024 / 1024).toFixed(1);
    return {
      kind: 'refused',
      message: `${shown} is ${megabytes} MB. An image in a note can be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`,
    };
  }
  return { kind: 'accepted', extension };
}

/** Why an image that passed the checks still cannot go in: the webview cannot draw it. */
export function undrawableImageMessage({
  name,
  extension,
}: {
  name: string;
  extension: string;
}): string {
  const shown = name === '' ? 'The pasted image' : `“${name}”`;
  if (extension === 'heic' || extension === 'heif') {
    return `${shown} is a HEIC photo this Mac cannot show here. Export it as JPEG or PNG first.`;
  }
  return `${shown} could not be read as an image.`;
}

/**
 * The name an image is saved under, before it is numbered clear of any
 * already there.
 *
 * A file keeps its own name, cleaned of what no filesystem allows. A pasted
 * image — no name, or the generic `image.png` a clipboard gives a screenshot
 * — is `Pasted image 20260925143012.png`, as Obsidian names one, stamped with
 * the local time it was pasted.
 */
export function imageFileName({
  image,
  extension,
  now,
}: {
  image: IncomingImage;
  extension: string;
  /** Local time, `YYYY-MM-DDTHH:mm:ss`, from the clock. */
  now: string;
}): string {
  const base = isGenericName(image) ? pastedBase(now) : cleanEntryName(stemOf(image.name));
  return `${base === '' ? pastedBase(now) : base}.${extension}`;
}

/**
 * `name`, or `name 2`, `name 3`… — the first not in `taken`, the way Finder
 * numbers copies. A name taken in another case counts: APFS refuses both.
 */
export function numberedFileName({
  name,
  taken,
}: {
  name: string;
  taken: readonly string[];
}): string {
  const lowered = new Set(taken.map(sameOnDisk));
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? name : `${stem} ${attempt}${extension}`;
    if (!lowered.has(sameOnDisk(candidate))) return candidate;
  }
}

/** A name as a case-insensitive, Unicode-normalising disk (APFS) sees it. */
function sameOnDisk(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** The alt text an image goes in with: its name for a file, nothing for a paste. */
export function defaultAltText(image: IncomingImage): string {
  return isGenericName(image) ? '' : cleanEntryName(stemOf(image.name));
}

const GENERIC_CLIPBOARD_NAME = /^image\.[a-z0-9]+$/i;

function isGenericName(image: IncomingImage): boolean {
  if (image.name.trim() === '') return true;
  return image.origin === 'clipboard' && GENERIC_CLIPBOARD_NAME.test(image.name);
}

function pastedBase(now: string): string {
  return `Pasted image ${now.replace(/\D/g, '').slice(0, 14)}`;
}

function embeddableExtension(image: IncomingImage): string | null {
  const named = extensionOf(image.name);
  if (EMBEDDABLE_IMAGE_EXTENSIONS.includes(named)) return named;
  const fromType = Object.entries(IMAGE_MIME_TYPES).find(
    ([extension, mime]) =>
      mime === image.mimeType.toLowerCase() && EMBEDDABLE_IMAGE_EXTENSIONS.includes(extension),
  );
  return fromType?.[0] ?? null;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
