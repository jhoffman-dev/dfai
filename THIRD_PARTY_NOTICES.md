# Third-party notices

DFAI's own code is MIT (see `LICENSE`). A built app also carries the work of others,
whose licences ask that their notice travels with it. This file ships in the app's
`dist` folder as `THIRD_PARTY_NOTICES.txt`; each licence text named below ships
beside the files it covers, under `pdfjs/` and `epub/`.

This file lists what is bundled into the _readers_ and their data files (#504, #505). The npm
dependencies of the rest of the app keep their licences in `node_modules` and in
`pnpm-lock.yaml`; a full generated list is a release task (see `RELEASING.md`).

## pdf.js (pdfjs-dist)

Reads and draws PDFs in the reader. Its code is bundled into the reader's chunk and its
worker script is shipped as a file.

- Copyright Mozilla Foundation and contributors
- Licence: Apache License 2.0 — `pdfjs/LICENSE`
- Source: https://github.com/mozilla/pdf.js

## foliate-js

Reads EPUBs in the EPUB reader (#505): a book's package, contents and metadata, and
its EPUB CFIs. Its code is bundled into the EPUB reader's chunk.

- Copyright (c) 2022 John Factotum
- Licence: MIT — `epub/foliate-js-LICENSE`
- Source: https://github.com/johnfactotum/foliate-js (npm `foliate-js` 1.0.1)

Only the modules the reader imports are bundled (`epub.js`, `epubcfi.js` and the
vendored `zip.js`). foliate-js's optional `construct-style-sheets-polyfill` is used
only by its fixed-layout view, which DFAI does not import, so it is not bundled.

## zip.js, as foliate-js vendors it

Reads an EPUB's ZIP archive in the EPUB reader. Bundled into its chunk, from
foliate-js's `vendor/zip.js`.

- Copyright (c) Gildas Lormeau
- Licence: BSD 3-Clause — `epub/zip.js-LICENSE` (the npm package carries no copy of
  it, so DFAI keeps the text in `packages/adapters/src/epub/zip.js-LICENSE`)
- Source: https://github.com/gildas-lormeau/zip.js

## Files pdf.js reads, shipped under `pdfjs/`

| Folder                  | What it is                                     | Licence file                                                           |
| ----------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| `pdfjs/cmaps/`          | Adobe character maps for East Asian text       | `pdfjs/cmaps/LICENSE` (Adobe, BSD-style)                               |
| `pdfjs/standard_fonts/` | Foxit and Liberation fonts for the standard 14 | `LICENSE_FOXIT` (BSD-style), `LICENSE_LIBERATION` (see its own text)   |
| `pdfjs/wasm/`           | JBIG2, OpenJPEG and qcms image decoders        | `LICENSE_JBIG2`, `LICENSE_OPENJPEG`, `LICENSE_QCMS`, `LICENSE_PDFJS_*` |

The Liberation fonts are licensed under the GNU General Public License v2 _with the
font exception_: a document made with the fonts is not itself covered. The fonts are
data files, loaded by address, and are not linked into DFAI's code.
