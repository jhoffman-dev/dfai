import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PAGE = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const CONFIG = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

/** The policy the page ships, from its meta tag. */
const policy = () =>
  /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(PAGE)?.[1] ?? null;

describe("the web page's policy (#656)", () => {
  it('runs only its own scripts, talks only to its own origin, and frames nothing live', () => {
    const directives = (policy() ?? '').split(';').map((directive) => directive.trim());
    expect(directives).toEqual(["script-src 'self'", "connect-src 'self'", "frame-src 'none'"]);
  });

  it('is the one the dev server loosens, so `pnpm dev` does not ship it loosened by mistake', () => {
    // vite.config.ts replaces this exact text, and only while serving.
    expect(CONFIG).toContain(`const WEB_CSP = "${policy()}";`);
    expect(CONFIG).toMatch(/apply: 'serve'/);
  });
});
