/*
 * What each platform DFAI runs on can do (#655, ADR-0051): pure data the UI
 * reads to hide what a platform lacks.
 */
export {
  capabilitiesLacking,
  DESKTOP_CAPABILITIES,
  PLATFORM_CAPABILITIES,
  WEB_CAPABILITIES,
} from './platform-capabilities.ts';
export type { PlatformCapabilities, PlatformCapability } from './platform-capabilities.ts';
