/*
 * Adding an EPUB to the library (#505, ADR-0043 §1): whether the bytes are
 * an EPUB at all, and whether it is one DFAI can open. A book sold with DRM
 * (the Kindle store, Apple Books, Kobo) has its chapters encrypted, and
 * cannot be read without the seller's key; it is refused, said plainly,
 * rather than shown as noise. Embedded fonts obfuscated as the EPUB
 * standard allows are not DRM: the words are in the clear.
 */

/** Whether `bytes` start as an EPUB does: an EPUB is a ZIP archive, whose first bytes are `PK\x03\x04`. */
export function looksLikeEpub(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** One `EncryptedData` of an EPUB's `META-INF/encryption.xml`: how a file of the book is encrypted. */
export interface EpubEncryption {
  /** The `EncryptionMethod`'s `Algorithm`, or null when it names none. */
  readonly algorithm: string | null;
  /** The `CipherReference`'s `URI`: the file it applies to, or null when it names none. */
  readonly uri: string | null;
}

/**
 * The algorithms the EPUB standard (IDPF) and Adobe use to obfuscate an
 * embedded font so it cannot be lifted out of the book. They hide no words.
 */
export const FONT_OBFUSCATION_ALGORITHMS: readonly string[] = [
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC',
];

/** Files a DRM scheme leaves in `META-INF`: Adobe's licence, Apple's FairPlay keys. */
const RIGHTS_FILES = ['meta-inf/rights.xml', 'meta-inf/sinf.xml'];

/** A file of the book whose words a reader needs: its package, navigation and chapters. */
const CONTENT_FILE = /\.(x?html?|xml|opf|ncx|css|svg)$/i;

export type EpubProtection = { readonly kind: 'open' } | { readonly kind: 'protected' };

/**
 * Whether an EPUB is DRM-protected: it has a DRM scheme's licence or keys
 * (`entries`, the archive's file names), or it encrypts a file by anything
 * but font obfuscation, or obfuscates a file that is not a font.
 */
export function epubProtection({
  encrypted,
  entries,
}: {
  encrypted: readonly EpubEncryption[];
  entries: readonly string[];
}): EpubProtection {
  const rights = entries.some((entry) => RIGHTS_FILES.includes(entry.toLowerCase()));
  const locked = encrypted.some(
    ({ algorithm, uri }) =>
      algorithm === null ||
      !FONT_OBFUSCATION_ALGORITHMS.includes(algorithm) ||
      (uri !== null && CONTENT_FILE.test(uri)),
  );
  return rights || locked ? { kind: 'protected' } : { kind: 'open' };
}

/** What the person is told about a DRM-protected EPUB named `name`, plainly. */
export function protectedEpubMessage(name: string): string {
  return (
    `“${name}” is protected with DRM, so DFAI can't open it. ` +
    'Books from the Kindle store, Apple Books and Kobo usually are; a DRM-free copy of the book opens.'
  );
}
