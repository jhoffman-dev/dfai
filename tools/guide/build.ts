// Writes docs/guide/index.html from docs/guide/src (#134). Run `pnpm guide:build`
// after editing a section; a test fails while the page is stale.
import { writeFile } from 'node:fs/promises';
import { buildGuide } from './build-guide.ts';
import { GUIDE_PAGE } from './sources.ts';

await writeFile(GUIDE_PAGE, await buildGuide());
console.log(`Wrote ${GUIDE_PAGE}`);
