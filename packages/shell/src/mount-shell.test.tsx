// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mountShell, type AppPorts } from './mount-shell.tsx';

describe('mountShell (#656)', () => {
  it('says so when the page has nowhere to draw the app', () => {
    document.body.innerHTML = '<main></main>';
    // Never drawn: the page is refused before any port is read.
    const ports = {} as AppPorts;
    expect(() => mountShell({ ports })).toThrow('index.html is missing #root');
  });
});
