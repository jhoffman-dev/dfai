import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/*
 * tools/ci/install-webkit-deps.sh against stand-ins for sudo, apt-get and
 * Playwright, so its choices (what it downloads, which cached files it trusts,
 * when it gives up) are checked without a real apt.
 */

const SCRIPT = join(import.meta.dirname, 'install-webkit-deps.sh');

/** The packages the stand-in Playwright reports missing, and their archives on the "mirror". */
const MIRROR = { 'liba_1_amd64.deb': 'contents of a', 'libb_1_amd64.deb': 'contents of b' };

const sha512 = (text: string) => createHash('sha512').update(text).digest('hex');

// `sudo` drops itself and `timeout`, so the stand-ins below run in its place.
const SUDO = `#!/usr/bin/env bash
[ "$1" = timeout ] && shift 2
exec "$@"
`;

// Reads $STATE/lists-stale (Playwright cannot answer until an update) and
// $STATE/update-fails; logs each download and install to $STATE/log.
const PNPM = `#!/usr/bin/env bash
if [ -f "$STATE/lists-stale" ]; then echo "E: Unable to locate package liba"; exit 1; fi
printf 'Missing system dependencies (2):\\n  liba\\n  libb\\n'; exit 1
`;

const APT_GET = `#!/usr/bin/env bash
case "$*" in
  update*)
    [ -f "$STATE/update-fails" ] && exit 100
    rm -f "$STATE/lists-stale"; exit 0;;
  *--print-uris*)
    for f in "$STATE"/mirror/*.deb; do
      name="$(basename "$f")"
      [ -f "$APT_ARCHIVES_DIR/$name" ] && continue
      # Like apt: MD5 unless a stronger hash is asked for.
      hash="MD5Sum:0123456789abcdef0123456789abcdef"
      case "$*" in *Acquire::ForceHash=SHA512*) hash="SHA512:$(sha512sum "$f" | cut -d' ' -f1)";; esac
      echo "'http://mirror.example.com/$name' $name $(wc -c < "$f" | tr -d ' ') $hash"
    done;;
  *--download-only*)
    [ -f "$STATE/update-fails" ] && exit 100
    for f in "$STATE"/mirror/*.deb; do
      name="$(basename "$f")"
      [ -f "$APT_ARCHIVES_DIR/$name" ] && continue
      cp "$f" "$APT_ARCHIVES_DIR/"; echo "download $name" >> "$STATE/log"
    done;;
  *--no-download*) echo "install" >> "$STATE/log";;
esac
`;

let root: string;
let state: string;
let archives: string;
let debs: string;
let path: string;

function stub(bin: string, name: string, body: string) {
  writeFileSync(join(bin, name), body);
  chmodSync(join(bin, name), 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dfai-webkit-deps-'));
  state = join(root, 'state');
  archives = join(root, 'archives');
  debs = join(root, 'debs');
  const bin = join(root, 'bin');
  for (const dir of [state, join(state, 'mirror'), archives, bin]) mkdirSync(dir);
  for (const [name, contents] of Object.entries(MIRROR)) {
    writeFileSync(join(state, 'mirror', name), contents);
  }
  stub(bin, 'sudo', SUDO);
  stub(bin, 'pnpm', PNPM);
  stub(bin, 'apt-get', APT_GET);
  // The test's own bin first; sha512sum, sed and the rest from the system.
  path = `${bin}:${process.env.PATH ?? ''}`;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(options: { cacheHit: boolean }) {
  const result = spawnSync('bash', [SCRIPT, debs], {
    encoding: 'utf8',
    env: {
      PATH: path,
      STATE: state,
      APT_ARCHIVES_DIR: archives,
      WEBKIT_DEBS_CACHE_HIT: options.cacheHit ? 'true' : '',
    },
  });
  const log = existsSync(join(state, 'log')) ? readFileSync(join(state, 'log'), 'utf8') : '';
  return { code: result.status, out: result.stdout + result.stderr, log: log.trim().split('\n') };
}

function cacheDebs(files: Record<string, string>) {
  mkdirSync(debs);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(debs, name), contents);
}

describe("installing WebKit's system packages", () => {
  it('on a miss, downloads what is missing, installs it, and keeps the files for the cache', () => {
    const { code, out, log } = run({ cacheHit: false });

    expect(code).toBe(0);
    expect(log).toEqual(['download liba_1_amd64.deb', 'download libb_1_amd64.deb', 'install']);
    expect(readFileSync(join(debs, 'liba_1_amd64.deb'), 'utf8')).toBe(MIRROR['liba_1_amd64.deb']);
    expect(out).toContain('Kept 2 .deb files for the cache.');
  });

  it('on a hit, installs from cached files that match apt’s hashes, downloading nothing', () => {
    cacheDebs(MIRROR);

    const { code, out, log } = run({ cacheHit: true });

    expect(code).toBe(0);
    expect(log).toEqual(['install']);
    expect(out).toContain("2 match apt's hashes and are used, 0 did not.");
  });

  it('does not use a cached file of the right size whose hash is wrong, and downloads it', () => {
    const forged = 'contents of X'; // the same length as the real 'contents of a'
    expect(forged.length).toBe(MIRROR['liba_1_amd64.deb'].length);
    expect(sha512(forged)).not.toBe(sha512(MIRROR['liba_1_amd64.deb']));
    cacheDebs({ ...MIRROR, 'liba_1_amd64.deb': forged });

    const { code, out, log } = run({ cacheHit: true });

    expect(code).toBe(0);
    expect(log).toEqual(['download liba_1_amd64.deb', 'install']);
    expect(readFileSync(join(archives, 'liba_1_amd64.deb'), 'utf8')).toBe(
      MIRROR['liba_1_amd64.deb'],
    );
    expect(out).toContain("1 match apt's hashes and are used, 1 did not.");
    expect(out).toContain('::warning::Cached liba_1_amd64.deb does not match its SHA512');
  });

  it('updates the lists and tries again when the image’s lists cannot answer', () => {
    writeFileSync(join(state, 'lists-stale'), '');

    const { code, log } = run({ cacheHit: false });

    expect(code).toBe(0);
    expect(log).toEqual(['download liba_1_amd64.deb', 'download libb_1_amd64.deb', 'install']);
  });

  it('fails with an error naming the mirror when every attempt fails, installing nothing', () => {
    writeFileSync(join(state, 'update-fails'), '');

    const { code, out, log } = run({ cacheHit: false });

    expect(code).toBe(1);
    expect(log).not.toContain('install');
    expect(out).toContain("::error::WebKit's system packages did not install");
    expect(out).toContain('slow apt mirror?');
  });
});
