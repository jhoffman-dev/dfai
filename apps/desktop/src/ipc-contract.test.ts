import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { API_RESPOND_COMMAND } from '@dfai/application';
import { createVaultPath, PLATFORM_CAPABILITIES, WEB_CAPABILITIES } from '@dfai/domain';
import type { PlatformCapability } from '@dfai/domain';
import { commandFatesIn, hostCommandsIn, type CommandFate } from './host-commands.test-support.ts';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

/**
 * The one seam neither the TypeScript tests nor the Rust tests can see: the command
 * names crossing the IPC boundary. Renaming a command on one side only would leave
 * both suites green and the app broken, so the two lists are compared directly.
 */

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

function commandsExposedByRust(): Set<string> {
  const exposed = hostCommandsIn(readFileSync(here('../src-tauri/src/lib.rs'), 'utf8'));
  expect(exposed, 'generate_handler! block not found in lib.rs').not.toBeNull();
  return exposed ?? new Set();
}

/** Every adapter source file, in every folder: a command called from any of them crosses the boundary. */
function adapterSources(): string[] {
  const root = here('../../../packages/adapters/src');
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => join(root, file));
}

function commandsCalledByAdapters(): Set<string> {
  const called = new Set<string>();
  for (const file of adapterSources()) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/invoke(?:<[^>]*>)?\(\s*'([a-zA-Z_]+)'/g)) {
      const name = match[1];
      if (name !== undefined) called.add(name);
    }
  }
  return called;
}

describe('IPC contract', () => {
  it('finds the commands the Rust side exposes', () => {
    expect(commandsExposedByRust().size).toBeGreaterThan(0);
  });

  it('finds the commands the adapters call', () => {
    expect(commandsCalledByAdapters().size).toBeGreaterThan(0);
  });

  it('every command the adapters call is exposed by Rust', () => {
    const exposed = commandsExposedByRust();
    const missing = [...commandsCalledByAdapters()].filter((name) => !exposed.has(name));
    expect(missing, `not registered in generate_handler!: ${missing.join(', ')}`).toEqual([]);
  });

  // Tauri matches arguments by name, camelCase in the webview and snake_case
  // in Rust, and drops one it does not know: a digest sent under another name
  // would leave every save held to the time alone, with both suites green (#245).
  it('sends a save every argument the host takes, under the name it takes it by', async () => {
    const rust = readFileSync(here('../src-tauri/src/vault.rs'), 'utf8');
    const declared = /pub async fn write_text_file\(([\s\S]*?)\)\s*->/.exec(rust)?.[1] ?? '';
    const taken = [...declared.matchAll(/(\w+):/g)]
      .map((match) => match[1] ?? '')
      .filter((name) => name !== 'app')
      .map((name) => name.replace(/_(\w)/g, (_, letter: string) => letter.toUpperCase()));
    expect(taken).toEqual(['path', 'contents', 'expectedModified', 'expectedDigest', 'vault']);

    const { tauriVaultFs } = await import('@dfai/adapters/tauri');
    invoke.mockResolvedValue(1);
    await tauriVaultFs.writeTextFile({
      path: createVaultPath('Plan.md'),
      contents: 'new',
      expectedModified: 1,
      expectedText: 'old',
      vault: '/vaults/Larkspur',
    });
    const [command, sent] = invoke.mock.calls.at(-1) ?? [];
    expect(command).toBe('write_text_file');
    expect(Object.keys(sent as object).sort()).toEqual([...taken].sort());
  });

  // The API's commands are called from `adapters/src/api`, and the answer's
  // name is fixed by the contract as well as by Rust: all three must agree.
  it('calls every command the local API needs, the answer under the name the contract gives it', () => {
    const called = commandsCalledByAdapters();
    const needed = [
      API_RESPOND_COMMAND,
      'api_status',
      'api_set_enabled',
      'api_token',
      'api_rotate_token',
      'api_router_register',
      'api_router_ready',
    ];
    expect(needed.filter((name) => !called.has(name))).toEqual([]);
  });

  // ADR-0035 part 4 (#172): the meeting import and a rule's Claude step read
  // how long this Mac has slept right before they act. Were the command
  // missing on either side, every synced vault's gate would stay shut with
  // both suites green; and on the main thread it would wait behind the
  // window's own work.
  it('reads how long this Mac has slept through a command the host exposes, off the main thread', () => {
    expect(commandsCalledByAdapters()).toContain('host_asleep_ms');
    expect(commandsExposedByRust()).toContain('host_asleep_ms');
    expect(threadOf('host_asleep_ms')).not.toBe('main');
  });

  // A secret's value goes into the host and never comes back out: the host
  // fills it into a request itself (P12-06). A command that answered with one
  // would hand it to the webview, so the only secret commands are these four,
  // none of which answers with a value (`secret_bind` only moves where one goes).
  it('exposes no command that could hand a secret back to the webview', () => {
    const secretCommands = [...commandsExposedByRust()].filter((name) => /secret/i.test(name));
    expect(secretCommands.sort()).toEqual([
      'secret_bind',
      'secret_delete',
      'secret_list',
      'secret_set',
    ]);
  });

  // P31-03: Google's tokens stay in the host as well (ADR-0030). The refresh
  // token is in the Keychain and the access token in the host's memory; these
  // commands answer with whether a sign-in is kept, its client and scopes, and
  // an API call's answer with every token struck from it. That none of them
  // ever carries a token is tested in Rust, where the answers are made
  // (`no_answer_or_failure_handed_to_the_webview_carries_a_token`); this holds
  // the list, so a command that could is not added without being seen.
  it('exposes only the Google commands that answer without a token', () => {
    const exposed = [...commandsExposedByRust()];
    const google = exposed.filter((name) => /google|oauth/i.test(name));
    expect(google.sort()).toEqual([
      'google_calendar_request',
      'google_connect',
      'google_connect_cancel',
      'google_disconnect',
      // An export's Doc (#501): Drive's files and upload only, the token added by the host.
      'google_drive_request',
      'google_status',
    ]);
    const tokenCommands = exposed.filter((name) => /token/i.test(name));
    expect(tokenCommands.sort()).toEqual(['api_rotate_token', 'api_token']);
  });

  // #105: Slack's user token stays in the host as Granola's key does (ADR-0034,
  // ADR-0017). These commands answer whether a token is kept and a read-only
  // method's answer with the token struck; that none carries it is tested in
  // Rust (`no_answer_or_failure_handed_to_the_webview_carries_the_token`). This
  // holds the list, so a command that could is not added without being seen.
  it('exposes only the Slack commands that answer without a token, each off the main thread', () => {
    const slack = [...commandsExposedByRust()].filter((name) => /slack/i.test(name));
    expect(slack.sort()).toEqual([
      'slack_connect',
      'slack_disconnect',
      'slack_request',
      'slack_status',
    ]);
    expect(slack.filter((name) => threadOf(name) === 'main')).toEqual([]);
  });

  // #135: a command that is not async runs on the host's main thread, which is
  // the window's. Building the index walks the vault, reads every note and
  // writes every row through these, so one of them left on the main thread
  // freezes the window for as long as it runs, whatever the webview does.
  // Nor on the async runtime's own workers, which a blocking call parks: the
  // local API server and every other async command share them.
  it('runs every command that builds or reads the index on a thread of its own', () => {
    const exposed = [...commandsExposedByRust()];
    const indexing = [...exposed.filter((name) => name.startsWith('index_')), ...VAULT_READS];
    expect(indexing).toContain('index_put');
    expect(indexing.filter((name) => threadOf(name) !== 'blocking pool')).toEqual([]);
  });

  // #238: every command that touches the vault's files, on the blocking pool.
  // A save lists the folders it touches — some two dozen calls — and an image
  // read can be 32 MB: on the main thread each holds the window while it runs.
  // Read from the modules that hold them, so a file command added there later
  // is held to it without being listed here.
  it('runs every command that reads or writes the vault on a thread of its own', () => {
    const commands = VAULT_FILE_MODULES.flatMap(commandsDeclaredIn);
    expect(commands).toEqual(
      expect.arrayContaining(['write_text_file', 'move_entry', 'watch_vault']),
    );
    expect(commands.filter((name) => threadOf(name) !== 'blocking pool')).toEqual([]);
  });

  // #89: turning the Local API on can wait up to two seconds for its port,
  // and off up to two for the server to stop. On the main thread, the window
  // would hold for as long; the status and the token are asked meanwhile.
  it('runs the Local API commands that can wait on a thread of its own', () => {
    const waiting = ['api_status', 'api_set_enabled', 'api_token', 'api_rotate_token'];
    expect(waiting.filter((name) => threadOf(name) !== 'blocking pool')).toEqual([]);
  });

  it('tells where a command runs from how it is declared', () => {
    expect(threadOf('api_router_ready')).toBe('main');
    // On the main thread with the page load that forgets the routers (#161),
    // so an id is never given out half-way through one.
    expect(threadOf('api_router_register')).toBe('main');
    expect(threadOf('activity_read')).toBe('blocking pool');
    const declared = (source: string) => threadDeclaredBy(source, 'probe');
    expect(declared('#[tauri::command]\npub fn probe() {}')).toBe('main');
    // A sync body on the runtime: off the main thread, and in the way of everything async.
    expect(declared('#[tauri::command(async)]\npub fn probe() {}')).toBe('runtime');
    expect(declared('#[tauri::command]\npub async fn probe() { read() }')).toBe('runtime');
    expect(declared('#[tauri::command]\npub async fn probe() { off_main(read).await }')).toBe(
      'blocking pool',
    );
    expect(
      declared(
        '#[tauri::command]\npub async fn probe() { tauri::async_runtime::spawn_blocking(read) }',
      ),
    ).toBe('blocking pool');
    // Only its own body counts, not the next command's.
    expect(
      declared(
        '#[tauri::command]\npub async fn probe() {}\n#[tauri::command]\npub async fn next() { off_main(read) }',
      ),
    ).toBe('runtime');
  });
});

/** The commands that walk the vault and read its notes for the index. */
const VAULT_READS = ['list_notes', 'read_notes'];

/** The host's modules that read, write and watch the vault's files. */
const VAULT_FILE_MODULES = ['vault.rs', 'vault_entries.rs', 'vault_files.rs', 'watcher.rs'];

/** The names of the commands one module of the host declares. */
function commandsDeclaredIn(module: string): string[] {
  const source = readFileSync(here(`../src-tauri/src/${module}`), 'utf8');
  return [...source.matchAll(/#\[tauri::command(?:\(async\))?\]\s*pub (?:async )?fn (\w+)/g)].map(
    (match) => match[1] ?? '',
  );
}

type CommandThread = 'main' | 'runtime' | 'blocking pool';

/**
 * Where the host runs the command of this name declared in `source`: its main
 * thread unless the command is async, the async runtime's workers if it is,
 * and a thread of the blocking pool when its body hands the work there (the
 * repo's `off_main` / `off_thread`, which wrap `spawn_blocking`). Null when
 * the source does not declare it.
 */
function threadDeclaredBy(source: string, command: string): CommandThread | null {
  const declared = new RegExp(
    String.raw`#\[tauri::command(\(async\))?\]\s*pub (async )?fn ${command}\b`,
  ).exec(source);
  if (declared === null) return null;
  if (declared[2] === undefined) return declared[1] === undefined ? 'main' : 'runtime';
  const rest = source.slice(declared.index + declared[0].length);
  const next = rest.search(/#\[tauri::command/);
  const body = next === -1 ? rest : rest.slice(0, next);
  return /\b(off_main|off_thread|spawn_blocking)\(/.test(body) ? 'blocking pool' : 'runtime';
}

function threadOf(command: string): CommandThread {
  const directory = here('../src-tauri/src');
  const sources = readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.rs'))
    .map((file) => readFileSync(join(directory, file), 'utf8'));
  for (const source of sources) {
    const thread = threadDeclaredBy(source, command);
    if (thread !== null) return thread;
  }
  throw new Error(`no #[tauri::command] named ${command} in src-tauri/src`);
}

/** ADR-0051: what each host command becomes on the web and on Windows. */
const PLATFORM_MAP =
  '../../../vault/docs/adr/0051-every-host-command-has-a-fate-on-the-web-and-on-windows.md';

const WEB_FATES = ['browser', 'server', 'absent'];
const WINDOWS_FATES = ['same', 'port'];
/** The capability cell of a command every platform needs. */
const EVERY_PLATFORM = '—';

/** Each command row of the ADR's tables, as a reader sees it. */
function commandFates(): CommandFate[] {
  return commandFatesIn(readFileSync(here(PLATFORM_MAP), 'utf8'));
}

const isCapability = (name: string): name is PlatformCapability =>
  (PLATFORM_CAPABILITIES as readonly string[]).includes(name);

describe('the platform map (ADR-0051)', () => {
  it('maps every command Rust exposes', () => {
    const mapped = new Set(commandFates().map((fate) => fate.command));
    const unmapped = [...commandsExposedByRust()].filter((name) => !mapped.has(name));
    expect(unmapped, `add a row to ADR-0051 for: ${unmapped.join(', ')}`).toEqual([]);
  });

  it('maps no command Rust no longer exposes, and none twice', () => {
    const exposed = commandsExposedByRust();
    const commands = commandFates().map((fate) => fate.command);
    expect(commands.filter((name) => !exposed.has(name))).toEqual([]);
    expect(commands.filter((name, at) => commands.indexOf(name) !== at)).toEqual([]);
  });

  it('gives every command a fate the ADR names, on the web and on Windows', () => {
    const unnamed = commandFates().filter(
      (fate) => !WEB_FATES.includes(fate.web) || !WINDOWS_FATES.includes(fate.windows),
    );
    expect(unnamed).toEqual([]);
  });

  it('ties every command to a capability, or to every platform', () => {
    const unknown = commandFates().filter(
      (fate) => fate.capability !== EVERY_PLATFORM && !isCapability(fate.capability),
    );
    expect(unknown).toEqual([]);
  });

  it('gives a command absent on the web a capability the web lacks, so its screen hides it', () => {
    const shown = commandFates().filter(
      (fate) =>
        fate.web === 'absent' &&
        (!isCapability(fate.capability) || WEB_CAPABILITIES[fate.capability]),
    );
    expect(shown).toEqual([]);
  });

  it('gives a command serving a capability the web lacks no fate on the web but absent', () => {
    const hiddenYetServed = commandFates().filter(
      (fate) =>
        isCapability(fate.capability) &&
        !WEB_CAPABILITIES[fate.capability] &&
        fate.web !== 'absent',
    );
    expect(hiddenYetServed).toEqual([]);
  });

  it('serves every capability the web lacks with at least one command absent there', () => {
    const absentOnTheWeb = new Set(
      commandFates()
        .filter((fate) => fate.web === 'absent')
        .map((fate) => fate.capability),
    );
    const unserved = PLATFORM_CAPABILITIES.filter(
      (name) => !WEB_CAPABILITIES[name] && !absentOnTheWeb.has(name),
    );
    expect(unserved).toEqual([]);
  });
});
