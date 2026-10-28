import punycode from 'node:punycode';
import { domainToASCII } from 'node:url';
import { describe, expect, it } from 'vitest';
import { domainKey, emailKey } from './meeting-email-key.ts';
import { punycodeDecode, punycodeEncode } from './meeting-punycode.ts';

/*
 * PR #604 attack (#199). The prime directive: two addresses that are different
 * mailboxes never share a key; a missed match is acceptable. Node's `url` and
 * `punycode` are the reference here, in the tests only.
 */

/** A seeded linear congruential generator: the same inputs on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const pick = <T>(random: () => number, from: readonly T[]): T =>
  from[Math.floor(random() * from.length)] as T;

/** Code points that fold, look alike, or IDNA maps: a small pool, so keys collide often. */
const DOMAIN_POOL = [
  ...'aAbB0-',
  'а', // Cyrillic a, a homoglyph of Latin a
  'Σ',
  'σ',
  'ς',
  'ß',
  'ẞ',
  'İ',
  'ı',
  'I',
  'i',
  'é',
  'é',
  'Ａ',
  'ａ',
  'K', // Kelvin sign
  'k',
  '​',
  '‍',
  '­',
  'ü',
  'Ü',
] as const;
const DOTS = ['.', '。', '．', '｡'] as const;

function randomDomain(random: () => number): string {
  const labels = Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
    const body = Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
      pick(random, DOMAIN_POOL),
    ).join('');
    return random() < 0.1 ? `xn--${body}` : body;
  });
  let domain = labels[0] ?? 'a';
  for (const each of labels.slice(1)) domain += pick(random, DOTS) + each;
  return random() < 0.1 ? `${domain}.` : domain;
}

/** The host DNS resolves (WHATWG URL / UTS #46), final dot aside; null when it is no host. */
function dnsHost(domain: string): string | null {
  const host = domainToASCII(domain).replace(/\.$/u, '');
  // An empty label (`a..b`, or one UTS #46 maps to nothing) is no host to compare.
  return host === '' || host.split('.').includes('') ? null : host;
}

describe('emailKey never shares a key between two DNS hosts (property, seeded)', () => {
  it('two domains with one key resolve to one host', () => {
    const random = seeded(604);
    const hostByKey = new Map<string, { domain: string; host: string }>();
    const clashes: string[] = [];
    for (let run = 0; run < 30_000; run++) {
      const domain = randomDomain(random);
      const host = dnsHost(domain);
      if (host === null) continue;
      const key = emailKey(`mara@${domain}`);
      const seen = hostByKey.get(key);
      if (seen !== undefined && seen.host !== host) {
        clashes.push(`${JSON.stringify(seen.domain)} vs ${JSON.stringify(domain)} -> ${key}`);
      }
      if (seen === undefined) hostByKey.set(key, { domain, host });
    }
    expect(clashes.slice(0, 5)).toEqual([]);
  });

  it('a capital sigma that ends a label keys as the host DNS reads (σ), not as ς', () => {
    // toLowerCase applies Final_Sigma: `ΟΔΟΣ` before a non-letter becomes `οδος`;
    // UTS #46 maps Σ to σ always, so `larkspur.ΟΔΟΣ` is xn--pxavbq, and
    // `larkspur.οδος` (final sigma typed) is another host, xn--pxavbm.
    expect(dnsHost('larkspur.ΟΔΟΣ')).not.toBe(dnsHost('larkspur.οδος'));
    expect(emailKey('mara@larkspur.ΟΔΟΣ')).not.toBe(emailKey('mara@larkspur.οδος'));
    expect(emailKey('mara@ΟΔΟΣ-ΕΝΑ.example')).not.toBe(emailKey('mara@οδος-ενα.example'));
    expect(emailKey('mara@ΟΔΟΣ。example')).not.toBe(emailKey('mara@οδος.example'));
  });
});

const LOCAL_POOL = [...'maRAq.+"', 'а', 'Ａ', 'ａ', '​', '‍', 'ü', 'ü', 'İ', 'ı'] as const;
const WRAP_SPACES = [' ', '\t', ' ', '　', '﻿'] as const;
const CONTROLS = ['\u0000', '\u0007', '\u001f', '\u007f', '\u0085'] as const;

function randomAddress(random: () => number): string {
  const local = Array.from({ length: 1 + Math.floor(random() * 6) }, () =>
    pick(random, random() < 0.05 ? CONTROLS : LOCAL_POOL),
  ).join('');
  let address = `${local}@${randomDomain(random)}`;
  if (random() < 0.2) address = `Mara Quill <${address}>`;
  if (random() < 0.2) address = pick(random, WRAP_SPACES) + address + pick(random, WRAP_SPACES);
  if (random() < 0.05) address = address.slice(0, Math.floor(random() * address.length));
  return address;
}

describe('emailKey on random addresses (property, seeded)', () => {
  it('never throws and is idempotent', () => {
    const random = seeded(1999);
    for (let run = 0; run < 20_000; run++) {
      const address = randomAddress(random);
      const key = emailKey(address);
      expect(emailKey(key), JSON.stringify(address)).toBe(key);
    }
  });

  it('a `Name <address>` wrapper and the spaces round it change nothing', () => {
    const random = seeded(2604);
    for (let run = 0; run < 5_000; run++) {
      const bare = randomAddress(random).replace(/[<>]/gu, '');
      if (bare.trim() === '') continue;
      expect(emailKey(` Mara Quill\u00a0<${bare}> `), JSON.stringify(bare)).toBe(emailKey(bare));
    }
  });

  it('keeps apart local parts that differ in a code point that is not case', () => {
    const random = seeded(77);
    for (let run = 0; run < 10_000; run++) {
      const local = Array.from({ length: 1 + Math.floor(random() * 5) }, () =>
        pick(random, ['m', 'a', 'r', '.']),
      ).join('');
      const at = Math.floor(random() * (local.length + 1));
      const insert = pick(random, ['а', '​', '‍', 'ａ', '.', '+x', '"']);
      const other = local.slice(0, at) + insert + local.slice(at);
      expect(emailKey(`${other}@example.com`), other).not.toBe(emailKey(`${local}@example.com`));
    }
  });
});

describe('emailKey: merge-direction edges', () => {
  it.each([
    ['a ZWSP in the local part', 'ma​ra@example.com', 'mara@example.com'],
    ['a ZWJ in the local part', 'ma‍ra@example.com', 'mara@example.com'],
    ['a ZWSP in the domain', 'mara@exam​ple.com', 'mara@example.com'],
    ['a ZWJ in the domain', 'mara@exam‍ple.com', 'mara@example.com'],
    ['a Cyrillic а in the local part', 'mаra@example.com', 'mara@example.com'],
    ['a Cyrillic а in the domain', 'mara@exаmple.com', 'mara@example.com'],
    ['a fullwidth local part', 'ｍａｒａ@example.com', 'mara@example.com'],
    ['a fullwidth domain', 'mara@ｅｘａｍｐｌｅ.com', 'mara@example.com'],
    ['a dotless ı', 'mıra@example.com', 'mira@example.com'],
    ['a dotted İ', 'mİra@example.com', 'mira@example.com'],
    ['ß and ss in the local part', 'straße@example.com', 'strasse@example.com'],
    ['ß and ss in the domain', 'mara@straße.example', 'mara@strasse.example'],
    ['a soft hyphen in the domain', 'mara@exam­ple.com', 'mara@example.com'],
    ['a control character in the domain', 'mara@example.com\u0000', 'mara@example.com'],
    [
      'a swapped display name and address',
      'evil@x.com <mara@example.com>',
      'mara@example.com <evil@x.com>',
    ],
    ['two subdomains', 'mara@mail.example.com', 'mara@example.com'],
  ])('keeps apart %s', (_, left, right) => {
    expect(emailKey(left)).not.toBe(emailKey(right));
  });

  it('gives no two different texts the empty key: `Mara <>` is not `Dana <>`', () => {
    expect(emailKey('Mara Quill <>')).not.toBe(emailKey('Dana Reyes <>'));
    expect(emailKey('mara@example.com <>')).not.toBe(emailKey('dana@example.com <  >'));
  });

  it('reads the `<…>` address only, so the display name never decides', () => {
    expect(emailKey('evil@x.com <mara@example.com>')).toBe('mara@example.com');
    expect(emailKey('mara@example.com <evil@x.com>')).toBe('evil@x.com');
  });
});

describe('punycode against Node’s (property, seeded)', () => {
  const RANGES: readonly (readonly [number, number])[] = [
    [0x61, 0x7a],
    [0x30, 0x39],
    [0x2d, 0x2d],
    [0xa0, 0x24f],
    [0x370, 0x3ff],
    [0x400, 0x4ff],
    [0x4e00, 0x9fff],
    [0xac00, 0xd7a3],
    [0x1f300, 0x1faff],
    [0x10000, 0x10ffff],
  ];
  function randomLabel(random: () => number): string {
    return Array.from({ length: 1 + Math.floor(random() * 12) }, () => {
      const [from, to] = pick(random, RANGES);
      let point = from + Math.floor(random() * (to - from + 1));
      if (point >= 0xd800 && point <= 0xdfff) point = 0x4e00;
      return String.fromCodePoint(point);
    }).join('');
  }

  it('encodes as Node does, and decodes back to the label', () => {
    const random = seeded(3492);
    for (let run = 0; run < 20_000; run++) {
      const label = randomLabel(random);
      const encoded = punycodeEncode(label);
      expect(encoded, JSON.stringify(label)).toBe(punycode.encode(label));
      expect(punycodeDecode(encoded), encoded).toBe(label);
    }
  });

  it('decodes random ASCII as Node does, or refuses it, and never throws', () => {
    const random = seeded(6492);
    const DIGITS = 'abcdefghijklmnopqrstuvwxyz0123456789-';
    for (let run = 0; run < 20_000; run++) {
      const text = Array.from({ length: Math.floor(random() * 10) }, () =>
        pick(random, [...DIGITS]),
      ).join('');
      const ours = punycodeDecode(text);
      if (ours === null) continue;
      expect(ours, text).toBe(punycode.decode(text));
    }
  });

  it('keeps a non-canonical or invalid `xn--` label as written, never throwing', () => {
    const random = seeded(4604);
    const DIGITS = 'abcdefghijklmnopqrstuvwxyz0123456789-';
    for (let run = 0; run < 20_000; run++) {
      const body = Array.from({ length: Math.floor(random() * 10) }, () =>
        pick(random, [...DIGITS]),
      ).join('');
      const label = `xn--${body}`;
      const key = domainKey(`${label}.example`);
      let decoded: string | null;
      try {
        decoded = punycode.decode(body);
      } catch {
        decoded = null; // Node refuses it: it is no punycode, so must be kept as written.
      }
      const canonical = decoded !== null && punycode.encode(decoded) === body;
      if (!canonical) expect(key, label).toBe(`${label}.example`);
    }
  });
});
