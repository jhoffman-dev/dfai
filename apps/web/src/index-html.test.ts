import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PAGE = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const CONFIG = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

/** The policy the page ships, from its meta tag. */
const policy = () =>
  /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(PAGE)?.[1] ?? null;

describe("the web page's policy (#656)", () => {
  it('runs only its own scripts and WebAssembly, talks only to its origin and GitHub’s API, and frames nothing live', () => {
    const directives = (policy() ?? '').split(';').map((directive) => directive.trim());
    expect(directives).toEqual([
      "script-src 'self' 'wasm-unsafe-eval'",
      "connect-src 'self' https://api.github.com",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
    ]);
  });

  it('is the one the dev server loosens, so `pnpm dev` does not ship it loosened by mistake', () => {
    // vite.config.ts replaces this exact text, and only while serving.
    // Prettier may wrap the constant onto the next line.
    expect(CONFIG.replace(/const WEB_CSP =\s+/, 'const WEB_CSP = ')).toContain(
      `const WEB_CSP = "${policy()}";`,
    );
    expect(CONFIG).toMatch(/apply: 'serve'/);
  });
});

/** A PNG's size, from its header: the first chunk is always IHDR, width then height. */
const pngSize = (file: URL) => {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

const TOKENS = readFileSync(
  new URL('../../../packages/shell/src/styles/tokens.css', import.meta.url),
  'utf8',
);
/** The ground colour in the light theme: the first `--bg` tokens.css declares. */
const lightGround = /--bg: (#[0-9a-f]{6})/.exec(TOKENS)?.[1];

const MANIFEST = JSON.parse(
  readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('installing the page to the Home Screen (#668)', () => {
  it('links the manifest, and names it DFAI, standalone, opening at the root and scoped to the site', () => {
    expect(PAGE).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(MANIFEST).toMatchObject({
      name: 'DFAI',
      short_name: 'DFAI',
      display: 'standalone',
      start_url: '/',
      scope: '/',
    });
  });

  it("colours the manifest and the page's theme from the design tokens' ground", () => {
    expect(lightGround).toBeDefined();
    expect(MANIFEST.background_color).toBe(lightGround);
    expect(MANIFEST.theme_color).toBe(lightGround);
    expect(PAGE).toContain(`<meta name="theme-color" content="${lightGround}" />`);
  });

  it('ships the icons the manifest names, at the sizes it says, and a 180px one for iPadOS', () => {
    const icons = MANIFEST.icons as { src: string; sizes: string }[];
    expect(icons.map((icon) => icon.sizes)).toEqual(['192x192', '512x512']);
    for (const icon of icons) {
      const [width, height] = icon.sizes.split('x').map(Number);
      expect(pngSize(new URL(`../public${icon.src}`, import.meta.url))).toEqual({ width, height });
    }
    expect(PAGE).toContain(
      '<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png" />',
    );
    expect(pngSize(new URL('../public/icons/apple-touch-icon.png', import.meta.url))).toEqual({
      width: 180,
      height: 180,
    });
  });

  it('tells iPadOS to open it full screen, under its own name, and lays out to the screen’s edges', () => {
    expect(PAGE).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(PAGE).toContain('<meta name="apple-mobile-web-app-title" content="DFAI" />');
    expect(PAGE).toContain(
      '<meta name="apple-mobile-web-app-status-bar-style" content="default" />',
    );
    expect(PAGE).toMatch(/<meta name="viewport" content="[^"]*viewport-fit=cover[^"]*" \/>/);
  });

  it("needs no CSP change: the worker is the page's own script, at the root, under script-src 'self'", () => {
    // No worker-src: the policy falls back to script-src for a worker, and 'self' covers /sw.js.
    expect(policy()).not.toContain('worker-src');
    expect(policy()).toContain("script-src 'self'");
  });
});
