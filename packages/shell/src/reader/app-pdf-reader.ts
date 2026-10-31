import workerAddress from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { pdfJsReader, type PdfJsReader } from '@dfai/adapters/pdf';

/*
 * The app's PDF reader (#504): pdf.js with its worker and its fonts, maps and
 * decoders all files of this build (`vite.config.ts`, `pdfjsFiles`), so
 * opening a PDF fetches nothing from outside the app. Imported only by the
 * readers' chunk (`readers.ts`), loaded on first use.
 */

const inBuild = (folder: string) => new URL(`pdfjs/${folder}/`, document.baseURI).href;

export const appPdfReader: PdfJsReader = pdfJsReader({
  worker: workerAddress,
  standardFonts: inBuild('standard_fonts'),
  characterMaps: inBuild('cmaps'),
  decoders: inBuild('wasm'),
});
