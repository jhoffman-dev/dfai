import { storedZip, type ZipFile } from './stored-zip.ts';

/*
 * EPUBs made for the reader's tests (#505): a package, a contents page, a
 * stylesheet and a few chapters, zipped as an EPUB is. The fables' words are
 * in the public domain (Aesop, as G. F. Townsend translated him in 1867 and
 * Joseph Jacobs in 1894); the book's title and its teller are made up.
 */

export interface FixtureChapter {
  /** The chapter's file, in `OEBPS/`. */
  readonly file: string;
  readonly title: string;
  /** The `<body>`'s XHTML. */
  readonly body: string;
  /** More of the `<head>`'s XHTML, after its title. */
  readonly head?: string;
}

export interface FixtureBook {
  readonly title?: string;
  readonly author?: string;
  readonly chapters: readonly FixtureChapter[];
  /** More files of the archive, after the book's own: a font, a picture, an encryption file. */
  readonly extra?: readonly ZipFile[];
  readonly stylesheet?: string;
}

const xhtml = (chapter: FixtureChapter) =>
  `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
<head>
<title>${chapter.title}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>${chapter.head ?? ''}
</head>
<body>
${chapter.body}
</body>
</html>
`;

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function packageDocument(book: FixtureBook): string {
  const items = book.chapters
    .map(
      (chapter, at) =>
        `    <item id="c${at + 1}" href="${chapter.file}" media-type="application/xhtml+xml"/>`,
    )
    .join('\n');
  const spine = book.chapters.map((_, at) => `    <itemref idref="c${at + 1}"/>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b</dc:identifier>
    ${book.title === undefined ? '' : `<dc:title>${escapeXml(book.title)}</dc:title>`}
    ${book.author === undefined ? '' : `<dc:creator>${escapeXml(book.author)}</dc:creator>`}
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-10-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
${items}
  </manifest>
  <spine>
${spine}
  </spine>
</package>
`;
}

function navDocument(book: FixtureBook): string {
  const entries = book.chapters
    .map((chapter) => `      <li><a href="${chapter.file}">${escapeXml(chapter.title)}</a></li>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
${entries}
    </ol>
  </nav>
</body>
</html>
`;
}

const CONTAINER = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

/** An EPUB of `book`, as bytes. */
export function fixtureEpub(book: FixtureBook): Buffer {
  return storedZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: packageDocument(book) },
    { name: 'OEBPS/nav.xhtml', data: navDocument(book) },
    { name: 'OEBPS/style.css', data: book.stylesheet ?? 'p { text-indent: 1em; }\n' },
    ...book.chapters.map((chapter) => ({ name: `OEBPS/${chapter.file}`, data: xhtml(chapter) })),
    ...(book.extra ?? []),
  ]);
}

/** The first fable: Townsend's "The Hare and the Tortoise" (1867). */
export const HARE_AND_TORTOISE: FixtureChapter = {
  file: 'hare.xhtml',
  title: 'The Hare and the Tortoise',
  body: `<h1 id="hare">The Hare and the Tortoise</h1>
<p>A Hare one day ridiculed the short feet and slow pace of the Tortoise, who replied,
  laughing: “Though you be swift as the wind, I will beat you in a race.”</p>
<p>The Hare, believing her assertion to be simply impossible, assented to the proposal;
  and they agreed that the Fox should choose the course and fix the goal.</p>
<p>On the day appointed for the race the two started together. The Tortoise never for a
  moment stopped, but went on with a slow but steady pace straight to the end of the course.</p>
<p>The Hare, lying down by the wayside, fell fast asleep. At last waking up, and moving as
  fast as he could, he saw the Tortoise had reached the goal.</p>
<p class="moral">Slow but steady wins the race.</p>`,
};

/** The second fable: Jacobs's "The Ant and the Grasshopper" (1894). */
export const ANT_AND_GRASSHOPPER: FixtureChapter = {
  file: 'grasshopper.xhtml',
  title: 'The Ant and the Grasshopper',
  body: `<h1 id="grasshopper">The Ant and the Grasshopper</h1>
<p>In a field one summer’s day a Grasshopper was hopping about, chirping and singing to its
  heart’s content.</p>
<p>An Ant passed by, bearing along with great toil an ear of corn he was taking to the nest.</p>
<p>“I am helping to lay up food for the winter,” said the Ant, “and recommend you to do the same.”</p>
<p id="winter">When the winter came the Grasshopper had no food and found itself dying of hunger.</p>
<p class="moral">It is best to prepare for the days of necessity.</p>`,
};

/** The book most tests read: two fables, a title and a teller, and contents. */
export function fablesFixtureEpub(): Buffer {
  return fixtureEpub({
    title: 'Fables of Brightwater',
    author: 'Mara Quill',
    chapters: [HARE_AND_TORTOISE, ANT_AND_GRASSHOPPER],
  });
}

/** A book locked as a store's DRM locks one: its chapters encrypted with AES, and a licence beside them. */
export function protectedFixtureEpub(): Buffer {
  return fixtureEpub({
    title: 'A Locked Book',
    author: 'Tobias Fenn',
    chapters: [HARE_AND_TORTOISE],
    extra: [
      {
        name: 'META-INF/encryption.xml',
        data: `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
    <enc:CipherData><enc:CipherReference URI="OEBPS/hare.xhtml"/></enc:CipherData>
  </enc:EncryptedData>
</encryption>
`,
      },
      { name: 'META-INF/rights.xml', data: '<?xml version="1.0"?><rights/>' },
    ],
  });
}

/** A book whose only encryption is the standard obfuscation of an embedded font: not DRM, so it opens. */
export function obfuscatedFontFixtureEpub(): Buffer {
  return fixtureEpub({
    title: 'Fables with a Font',
    author: 'Mara Quill',
    chapters: [HARE_AND_TORTOISE],
    extra: [
      { name: 'OEBPS/fonts/serif.otf', data: new Uint8Array(64) },
      {
        name: 'META-INF/encryption.xml',
        data: `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
    <enc:CipherData><enc:CipherReference URI="OEBPS/fonts/serif.otf"/></enc:CipherData>
  </enc:EncryptedData>
</encryption>
`,
      },
    ],
  });
}

/** Where the hostile book's beacons and scripts would reach, were they let: nothing of it may be asked for. */
export const HOSTILE_ORIGIN = 'https://beacon.example.com';

/** What the hostile book's SVG asks for and runs, were it ever a document of the app's own origin. */
export const HOSTILE_IPC_COMMAND = 'hostile_probe';

/**
 * A picture of the book that holds a script (#505): shown as a picture it
 * runs nothing, but a frame led to it as a document of the app's origin
 * would run it with the app's window as its parent — and so its IPC.
 */
const EVIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">
<script>
try { window.__hostileRan = 'book svg'; } catch (e) {}
try { window.parent.__hostileRan = 'book svg in the app'; } catch (e) {}
try { window.top.__hostileRan = 'book svg in the app'; } catch (e) {}
try { window.parent.__TAURI_INTERNALS__.invoke('${HOSTILE_IPC_COMMAND}', {}); } catch (e) {}
</script>
<rect id="mark" width="20" height="20" fill="#88aa88"/>
</svg>
`;

/**
 * A book that tries everything a book should not (#505): scripts in every
 * form, pictures, fonts, stylesheets and frames on another site, a refresh,
 * a form, `<base>`, and links out — and one link inside the book, which
 * must still go where it says.
 */
export function hostileFixtureEpub(): Buffer {
  const remote = (path: string) => `${HOSTILE_ORIGIN}/${path}`;
  const first: FixtureChapter = {
    file: 'hostile.xhtml',
    title: 'The Hostile Chapter',
    head: `
<meta http-equiv="refresh" content="0; url=${remote('refresh')}"/>
<base href="${remote('base/')}"/>
<link rel="stylesheet" href="${remote('style.css')}"/>
<link rel="prefetch" href="${remote('prefetch')}"/>
<style>
@import url("${remote('import.css')}");
@font-face { font-family: "Beacon"; src: url("${remote('font.woff')}"); }
body { background-image: url("${remote('background.png')}"); }
</style>
<script>window.parent.__hostileRan = 'head script'; window.top.__hostileRan = 'head script';</script>`,
    body: `<h1>The Hostile Chapter</h1>
<p id="plain">A Hare one day ridiculed the short feet and slow pace of the Tortoise.</p>
<script>window.parent.__hostileRan = 'body script'; fetch("${remote('fetch')}");</script>
<p><img src="${remote('beacon.png')}" alt="beacon"/></p>
<p><img src="missing.png" onerror="window.parent.__hostileRan = 'onerror'" alt="handler"/></p>
<p onclick="window.parent.__hostileRan = 'onclick'" style="background: url(${remote('inline.png')})">Click this line.</p>
<iframe src="${remote('frame')}"></iframe>
<object data="${remote('object')}"></object>
<embed src="${remote('embed')}"/>
<video src="${remote('video.mp4')}" poster="${remote('poster.png')}"></video>
<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>window.parent.__hostileRan = 'svg script';</script><image href="${remote('svg.png')}" width="10" height="10"/></svg>
<form action="${remote('post')}" method="post"><button type="submit" id="send">Send</button></form>
<p><a id="out" href="${remote('out')}">Leave the book</a></p>
<p><a id="js" href="javascript:window.parent.__hostileRan = 'javascript link'">Run a script</a></p>
<p><a id="inside" href="calm.xhtml#calm">Go to the calm chapter</a></p>
<p><math xmlns="http://www.w3.org/1998/Math/MathML"><mtext id="mathlink" href="evil.svg">Follow the math</mtext></math></p>
<p><math xmlns="http://www.w3.org/1998/Math/MathML"><mtext id="forged" data-dfai-href="OEBPS/evil.svg">Follow the forged path</mtext></math></p>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="20"><a href="evil.svg"><text id="svglink" x="0" y="15">Follow the picture</text></a></svg>
<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><use href="evil.svg#mark"/></svg>
<p><img id="evilimg" src="evil.svg" alt="the book's own picture"/></p>`,
  };
  const second: FixtureChapter = {
    file: 'calm.xhtml',
    title: 'The Calm Chapter',
    body: `<h1 id="calm">The Calm Chapter</h1>\n<p>Slow but steady wins the race.</p>`,
  };
  return fixtureEpub({
    title: 'A Hostile Book',
    author: 'Tobias Fenn',
    chapters: [first, second],
    extra: [{ name: 'OEBPS/evil.svg', data: EVIL_SVG }],
  });
}

/** The sentences the long book is written in: Townsend's and Jacobs's fables, in the public domain. */
const LONG_BOOK_SENTENCES = [
  'A Hare one day ridiculed the short feet and slow pace of the Tortoise.',
  'The Tortoise never for a moment stopped, but went on with a slow but steady pace.',
  'The Hare, lying down by the wayside, fell fast asleep.',
  'In a field one summer’s day a Grasshopper was hopping about, chirping and singing.',
  'An Ant passed by, bearing along with great toil an ear of corn.',
  'When the winter came the Grasshopper had no food and found itself dying of hunger.',
  'It is best to prepare for the days of necessity.',
];

/** What the long book's find looks for: in every hundredth chapter, and nowhere else. */
export const LONG_BOOK_PHRASE = 'the lantern of Brightwater';

/** A chapter of the long book: about `size` characters of fables, the phrase find looks for in every hundredth. */
function longBookChapter(at: number, size: number): FixtureChapter {
  const paragraphs: string[] = [];
  let written = 0;
  for (let line = 0; written < size; line += 1) {
    const sentences = Array.from(
      { length: 6 },
      (_, n) => LONG_BOOK_SENTENCES[(at + line + n) % LONG_BOOK_SENTENCES.length] as string,
    );
    if (line === 3 && (at + 1) % 100 === 0) sentences.push(`Far off shone ${LONG_BOOK_PHRASE}.`);
    const paragraph = `<p>${sentences.join(' ')}</p>`;
    paragraphs.push(paragraph);
    written += paragraph.length;
  }
  return {
    file: `chapter-${String(at + 1).padStart(4, '0')}.xhtml`,
    title: `Chapter ${at + 1}`,
    body: `<h1>Chapter ${at + 1}</h1>\n${paragraphs.join('\n')}`,
  };
}

/** A long book for the reader's work budgets (#505): `chapters` chapters of about `chapterSize` characters each. */
export function longFixtureEpub({
  chapters = 1000,
  chapterSize = 30_000,
}: { chapters?: number; chapterSize?: number } = {}): Buffer {
  return fixtureEpub({
    title: 'A Long Voyage',
    author: 'Tobias Fenn',
    chapters: Array.from({ length: chapters }, (_, at) => longBookChapter(at, chapterSize)),
  });
}
