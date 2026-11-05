/*
 * The Field Guide as it is published: its sources assembled, with the web's
 * list of what it cannot do drawn from the capability map (#670). `pnpm
 * guide:build` writes it and a test holds the committed page to it.
 *
 * The platform modules are imported by their own entry points rather than
 * through `@dfai/domain`: plain Node runs this, and the domain's whole index
 * holds TypeScript it cannot strip.
 */
import { WEB_CAPABILITIES } from '../../packages/domain/src/platform/index.ts';
import { platformLimits } from '../../packages/application/src/platform/index.ts';
import { assembleGuide } from './assemble.ts';
import { readGuideSources } from './sources.ts';
import { withWebLimits } from './web-limits.ts';

/** What DFAI on the web cannot do, as the guide lists it. */
export const WEB_LIMITS = platformLimits(WEB_CAPABILITIES);

/** The published page, from the sources under `source` (docs/guide/src by default). */
export async function buildGuide(source?: string): Promise<string> {
  return assembleGuide(withWebLimits(await readGuideSources(source), WEB_LIMITS));
}
