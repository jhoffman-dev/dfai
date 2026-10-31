import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PLATFORM_CAPABILITIES, WEB_CAPABILITIES } from '@dfai/domain';
import type { PlatformCapability } from '@dfai/domain';

/**
 * Attack tests for PR #681 (the ADR-0051 platform map guard). Each `it.fails`
 * proves a gap that is real today; it turns red, and should become a plain
 * `it`, once the gap is closed.
 *
 * The two parsers below are verbatim copies of `commandsExposedByRust` and
 * `commandFates` in ipc-contract.test.ts, taking the source as an argument so
 * other formatting can be fed in. Keep them in step with the originals.
 */

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const PLATFORM_MAP =
  '../../../vault/docs/adr/0051-every-host-command-has-a-fate-on-the-web-and-on-windows.md';

function commandsExposedBy(source: string): Set<string> {
  const handler = /generate_handler!\[([\s\S]*?)\]/.exec(source);
  return new Set(
    (handler?.[1] ?? '')
      .split(',')
      .map((entry) => entry.trim().split('::').at(-1) ?? '')
      .filter((name) => name !== ''),
  );
}

function commandFatesIn(source: string) {
  const row = /^\|\s*`(\w+)`\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/gm;
  return [...source.matchAll(row)].map(([, command, capability, web, windows]) => ({
    command: command ?? '',
    capability: capability ?? '',
    web: web ?? '',
    windows: windows ?? '',
  }));
}

const isCapability = (name: string): name is PlatformCapability =>
  (PLATFORM_CAPABILITIES as readonly string[]).includes(name);

describe('attack #681: reading generate_handler!', () => {
  it('reads a plain multi-line list with module paths and a trailing comma', () => {
    const source = `tauri::generate_handler![
      report_error,
      vault::read_text_file,
      git::git_run,
    ])`;
    expect([...commandsExposedBy(source)]).toEqual(['report_error', 'read_text_file', 'git_run']);
  });

  // tauri-macros 2.6.3 (our Cargo.lock) parses outer attributes on each entry
  // (`Attribute::parse_outer` in command/handler.rs), so the Windows port (#673)
  // can gate a macOS-only command in place. The lazy `\]` stops at the
  // attribute's own `]`, and every command after it vanishes from "exposed".
  it.fails('keeps every command after a #[cfg(...)]-gated entry', () => {
    const source = `tauri::generate_handler![
      report_error,
      #[cfg(target_os = "macos")]
      kindle::kindle_connect,
      vault::read_text_file,
    ])`;
    expect([...commandsExposedBy(source)].sort()).toEqual(
      ['kindle_connect', 'read_text_file', 'report_error'].sort(),
    );
  });

  it.fails('does not split a cfg(any(a, b)) attribute into phantom commands', () => {
    const source = `tauri::generate_handler![
      #[cfg(any(target_os = "macos", windows))]
      trash::trash_entry,
      report_error,
    ])`;
    for (const name of commandsExposedBy(source)) expect(name).toMatch(/^\w+$/);
  });

  it.fails('does not count a commented-out command as exposed', () => {
    const source = `tauri::generate_handler![
      report_error,
      // kindle::kindle_connect, (off until #673)
      vault::read_text_file,
    ])`;
    expect(commandsExposedBy(source).has('kindle_connect')).toBe(false);
  });
});

describe('attack #681: reading the ADR-0051 table', () => {
  // A row hidden in an HTML comment does not render, yet maps its command.
  it.fails('does not count a row inside an HTML comment as a mapping', () => {
    const source = ['<!--', '| `kindle_connect` | kindle | absent | port | hidden |', '-->'].join(
      '\n',
    );
    expect(commandFatesIn(source)).toEqual([]);
  });

  it.fails('does not count a row inside a fenced code block as a mapping', () => {
    const source = ['```md', '| `kindle_connect` | kindle | absent | port | example |', '```'].join(
      '\n',
    );
    expect(commandFatesIn(source)).toEqual([]);
  });
});

describe('attack #681: the map as written', () => {
  // The guard's test is named "serves a capability the web lacks with every
  // command absent on the web" but only checks the converse (absent => lacking).
  // ADR-0051 decision 2: the screen hides a feature because its capability is
  // false. trash_entry, git_run and gh_repo_list are `server` on the web yet
  // serve systemTrash / syncByGit, which the web lacks, so a screen that obeys
  // WEB_CAPABILITIES hides delete and the repo list the row says the web has.
  it.fails('gives every command serving a capability the web lacks the fate absent', () => {
    const fates = commandFatesIn(readFileSync(here(PLATFORM_MAP), 'utf8'));
    const servedAnyway = fates
      .filter((fate) => isCapability(fate.capability) && !WEB_CAPABILITIES[fate.capability])
      .filter((fate) => fate.web !== 'absent')
      .map((fate) => `${fate.command} (${fate.capability}, ${fate.web})`);
    expect(servedAnyway).toEqual([]);
  });
});
