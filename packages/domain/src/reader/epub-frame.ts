/*
 * What a chapter of an EPUB may do when it is shown (#505, ADR-0045). A book
 * is untrusted: it may hold scripts, pictures on other sites (a beacon that
 * says who read what, and when), frames, forms and links out. It is shown in
 * a frame with an opaque origin (`EPUB_FRAME_SANDBOX`), under this policy:
 * the only script that runs there is DFAI's own, named by its hash; the book
 * is handed to it as data, and every file of the book as a `data:` address.
 * Every reference in a chapter is resolved here first: one inside the book is
 * read from the book, anything else is not loaded and not followed.
 */

/**
 * The frame's sandbox: scripts may run, and nothing else. Without
 * `allow-same-origin` the frame's origin is opaque, so nothing in it — DFAI's
 * script, or one of the book's that got past everything else — can reach the
 * app's window, its storage or its IPC; whatever it navigates to stays opaque.
 * No forms, no pop-ups, no navigation of the window.
 */
export const EPUB_FRAME_SANDBOX = 'allow-scripts';

const SHA256_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

/**
 * The policy a chapter's frame is made under, set by a `<meta>` DFAI puts
 * first in it: the one script whose SHA-256 is `bootstrapHash` (base64) runs,
 * and no other; nothing is fetched — the book's pictures and fonts come
 * written in, as `data:`; no request, no frame, no form, no `<base>`.
 */
export function epubFramePolicy(bootstrapHash: string): string {
  if (!SHA256_BASE64.test(bootstrapHash)) {
    throw new Error(`"${bootstrapHash}" is not a SHA-256 hash in base64.`);
  }
  return [
    "default-src 'none'",
    `script-src 'sha256-${bootstrapHash}'`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    'media-src data:',
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** Where a reference in a book's file points. */
export type BookReference =
  /** A file of the book, by its path in the archive, and the place in it (`#id`) when it names one. */
  | { readonly kind: 'inside'; readonly path: string; readonly fragment: string | null }
  /** A picture or font written into the book itself: shown, never followed. */
  | { readonly kind: 'data' }
  /** Anything else — another site, a mail address, a script, a path out of the book: not loaded, not followed. */
  | { readonly kind: 'outside' };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Where `ref`, written in the book's file at `from` (its path in the
 * archive), points. A relative path is read against `from`'s folder, `%`
 * escapes decoded; one that climbs out of the archive's top is outside it.
 */
export function bookReference({ from, ref }: { from: string; ref: string }): BookReference {
  const written = ref.trim();
  if (/^data:/i.test(written)) return { kind: 'data' };
  if (written.startsWith('//') || SCHEME.test(written)) return { kind: 'outside' };
  const hash = written.indexOf('#');
  const pathPart = (hash === -1 ? written : written.slice(0, hash)).split('?')[0] ?? '';
  const fragment = hash === -1 ? null : decoded(written.slice(hash + 1));
  if (pathPart === '') {
    return fragment === null ? { kind: 'outside' } : { kind: 'inside', path: from, fragment };
  }
  const path = decoded(pathPart);
  if (path === null) return { kind: 'outside' };
  const resolved = resolvedPath(from, path);
  return resolved === null ? { kind: 'outside' } : { kind: 'inside', path: resolved, fragment };
}

function decoded(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    // A `%` that starts no escape is no path a book's file can have.
    return null;
  }
}

/** `path` read against the folder `from` is in; null when it climbs above the archive's top. */
function resolvedPath(from: string, path: string): string | null {
  const segments = path.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') segments.push(segment);
    else if (segments.pop() === undefined) return null;
  }
  return segments.length === 0 ? null : segments.join('/');
}
