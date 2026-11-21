import type { WorkSwitch } from '../platform/entry-points.ts';

/**
 * A runner's switch for a test (#920): the one way to make a `WorkSwitch`
 * outside `workOffered`. The app reads its switches from `working` alone;
 * a test of one runner hands it on or off with this.
 */
export function workSwitch(on: boolean): WorkSwitch {
  return on as WorkSwitch;
}
