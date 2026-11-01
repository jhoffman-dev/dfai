// @vitest-environment jsdom
/*
 * Attack on PR #699 (#657): composedForApp's promise that "the app never has
 * a feature on and its port missing", for every port a composition may leave
 * out, and that the desktop loses nothing it showed before.
 */
import { describe, expect, it } from 'vitest';
import { EVERY_ENTRY_POINT } from '@dfai/application';
import { DESKTOP_CAPABILITIES } from '@dfai/domain';
import { composedForApp, type AppPorts } from './mount-shell.tsx';

/** Never read: composedForApp only asks which ports are there. */
const ALL = {
  appInfo: {},
  kindle: {},
  semantic: {},
  exporting: {},
  meetings: {},
  blocks: {},
} as unknown as AppPorts;

const without = (name: keyof AppPorts) =>
  Object.fromEntries(Object.entries(ALL).filter(([key]) => key !== name)) as unknown as AppPorts;

describe('composedForApp (#699 attack)', () => {
  it('offers the desktop, with every port, every entry point', () => {
    expect(composedForApp({ ports: ALL, capabilities: DESKTOP_CAPABILITIES }).offered).toEqual(
      EVERY_ENTRY_POINT,
    );
  });

  it.each(['meetings', 'blocks'] as const)(
    'offers no calendar sync where the %s port is left out, as it does for kindle, semantic and exporting',
    (port) => {
      const { offered } = composedForApp({
        ports: without(port),
        capabilities: DESKTOP_CAPABILITIES,
      });
      expect(offered[port === 'meetings' ? 'meetingSync' : 'blockSync']).toBe(false);
    },
  );
});
