import { describe, expect, it } from 'vitest';
import e2e from '../../playwright.config.ts';
import gallery from '../../playwright.gallery.config.ts';
import shots from '../../playwright.shots.config.ts';

/**
 * PR #328 under attack: `pnpm shots:gallery` serves Vite on a port of its
 * own and must never be picked up by the e2e suite, the shots run or CI.
 */
const portOf = (url: string | undefined) => Number(new URL(url ?? '').port);

/** Every port playwright.config.ts can hand a checkout (4173 + hash % 800). */
const E2E_PORTS = { first: 4173, last: 4173 + 799 };

describe('the gallery shots config (#328)', () => {
  it('serves on a port no checkout’s e2e server can have, nor Tauri’s 1420', () => {
    const port = portOf(gallery.use?.baseURL);
    expect(port).toBe(portOf(e2e.use?.baseURL) + 1000);
    // The lowest and highest gallery ports, against the whole e2e range.
    expect(E2E_PORTS.first + 1000).toBeGreaterThan(E2E_PORTS.last);
    expect(port).not.toBe(1420);
    const server = Array.isArray(gallery.webServer) ? gallery.webServer[0] : gallery.webServer;
    expect(server?.command).toContain(`--port ${port} --strictPort`);
    expect(server?.reuseExistingServer).toBe(false);
  });

  it('is not matched by the e2e suite or the app shots run', () => {
    expect(e2e.testDir).toBe('./e2e');
    expect(shots.testDir).toBe('./tools/design/shots');
    expect(shots.testMatch).toBe('*.shots.spec.ts');
    expect(gallery.testDir).toBe('./tools/design');
    // The gallery's own shots and the attack specs that judge it, by name — never an e2e spec.
    const match = gallery.testMatch;
    if (!(match instanceof RegExp)) throw new Error('the gallery config matches by regex');
    expect(match.test('/repo/tools/design/gallery.spec.ts')).toBe(true);
    expect(match.test('/repo/tools/design/gallery-cells.attack-354.spec.ts')).toBe(true);
    expect(match.test('/repo/e2e/table-keyboard.spec.ts')).toBe(false);
    expect(match.test('/repo/tools/design/shots/app.shots.spec.ts')).toBe(false);
    expect(match.test('/repo/tools/design/gallery.right-sidebar.attack-353.spec.ts')).toBe(true);
    expect(match.test('/repo/tools/design/right-sidebar.attack-353.spec.ts')).toBe(false);
  });
});
