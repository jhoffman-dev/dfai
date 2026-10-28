import { describe, expect, it } from 'vitest';
import { domainKey, emailKey } from './meeting-email-key.ts';
import { punycodeDecode, punycodeEncode } from './meeting-punycode.ts';

/*
 * #199: one key for every place two addresses are compared — Person
 * matching, the Granola "me" check, group addresses, merges. Files keep an
 * address as written (ADR-0003); only comparisons use the key.
 */

describe('emailKey', () => {
  it('folds the case of the local part and the domain alike', () => {
    expect(emailKey('Mara.Quill@Example.COM')).toBe('mara.quill@example.com');
    expect(emailKey('MARA.QUILL@example.com')).toBe(emailKey('mara.quill@EXAMPLE.com'));
  });

  it('composes the address (NFC), so one typed decomposed is the one a meeting lists', () => {
    expect(emailKey('rén@example.com')).toBe('rén@example.com');
    expect(emailKey('mara@bücher.example')).toBe(emailKey('mara@bücher.example'));
  });

  it('reads a Unicode domain as its ASCII (punycode) form, either way it arrives', () => {
    expect(emailKey('Mara@Bücher.Example')).toBe('mara@xn--bcher-kva.example');
    expect(emailKey('mara@xn--bcher-kva.example')).toBe('mara@xn--bcher-kva.example');
    expect(emailKey('mara@XN--BCHER-KVA.example')).toBe('mara@xn--bcher-kva.example');
    expect(emailKey('rén@bücher.example')).toBe('rén@xn--bcher-kva.example');
  });

  it('sets aside the spaces round it', () => {
    expect(emailKey(' \tMara.Quill@example.com  ')).toBe('mara.quill@example.com');
  });

  it('reads the address out of `Name <address>`, as a mail client copies it', () => {
    expect(emailKey('Mara Quill <mara@example.com>')).toBe('mara@example.com');
    expect(emailKey('"Quill, Mara" < Mara@Bücher.example > ')).toBe('mara@xn--bcher-kva.example');
  });

  it('drops a final dot on the domain: `example.com.` is `example.com`', () => {
    expect(emailKey('mara@example.com.')).toBe('mara@example.com');
    expect(emailKey('mara@bücher.example.')).toBe('mara@xn--bcher-kva.example');
  });

  it('keeps a `+tag` as its own address: plus-addressing is not folded here', () => {
    expect(emailKey('mara+payroll@example.com')).toBe('mara+payroll@example.com');
    expect(emailKey('mara+payroll@example.com')).not.toBe(emailKey('mara@example.com'));
  });

  it('never reads a domain holding what a URL would take apart as another domain', () => {
    expect(emailKey('mara@bücher.example/evil.example')).toBe('mara@bücher.example/evil.example');
    expect(emailKey('mara@bücher.example:80')).toBe('mara@bücher.example:80');
    expect(emailKey('mara@bü\tcher.example')).toBe('mara@bü\tcher.example');
  });

  it('leaves a domain holding an `xn--` label that is not punycode as it is written', () => {
    expect(emailKey('mara@xn--a.bü')).toBe('mara@xn--a.bü');
  });

  it('leaves text that is not an address as it is, composed and case folded', () => {
    expect(emailKey('Mara')).toBe('mara');
    expect(emailKey('')).toBe('');
    expect(emailKey('mara@')).toBe('mara@');
  });

  it('tells apart addresses that differ', () => {
    expect(emailKey('mara@bucher.example')).not.toBe(emailKey('mara@bücher.example'));
    expect(emailKey('mara@example.com')).not.toBe(emailKey('mara@example.org'));
  });
});

describe('domainKey', () => {
  it('is the form a URL host takes, in the engine the tests run in', () => {
    for (const domain of [
      'bücher.example',
      'münchen.example',
      'xn--mnchen-3ya.example',
      '日本語.example',
      'пример.example',
      'ελληνικά.example',
      'straße.example',
      'ñandú.example',
      'Bücher.Example',
      'larkspur.example',
      'a-b.bücher.example',
    ]) {
      expect(domainKey(domain), domain).toBe(new URL(`http://${domain}/`).hostname);
    }
  });

  it('maps the ideographic full stops to a dot, as IDNA does', () => {
    expect(domainKey('bücher。example')).toBe('xn--bcher-kva.example');
    expect(domainKey('bücher．example｡')).toBe('xn--bcher-kva.example');
  });
});

describe('punycode (RFC 3492)', () => {
  // RFC 3492 §7.1 samples, and labels the tests above rely on.
  it.each([
    ['bücher', 'bcher-kva'],
    ['münchen', 'mnchen-3ya'],
    ['日本語', 'wgv71a119e'],
    ['пример', 'e1afmkfd'],
    ['ليهمابتكلموشعربي؟', 'egbpdaj6bu4bxfgehfvwxn'],
    ['他们为什么不说中文', 'ihqwcrb4cv8a8dqg056pqjye'],
    ['3年b組金八先生', '3b-ww4c5e180e575a65lsy2b'],
  ])('encodes %s as %s and reads it back', (unicode, ascii) => {
    expect(punycodeEncode(unicode)).toBe(ascii);
    expect(punycodeDecode(ascii)).toBe(unicode);
  });

  it('reads nothing from text that is not punycode', () => {
    expect(punycodeDecode('bcher-kv!')).toBeNull();
    expect(punycodeDecode('bü-kva')).toBeNull();
    expect(punycodeDecode('99999999999999')).toBeNull();
  });
});

/*
 * PR #604 review: an `xn--` label that is not the canonical A-label of its
 * Unicode was decoded, folded and encoded again, so two DNS labels shared a
 * key. When in doubt, keep them apart.
 */
describe('emailKey keeps an `xn--` label that is not canonical apart', () => {
  it.each([
    ['a leading delimiter, which RFC 3492 refuses', 'a@xn---tda.example'],
    ['an upper-case letter encoded (Ü)', 'a@xn--wca.example'],
    ['a decomposed letter encoded (u and a combining diaeresis)', 'a@xn--u-ccb.example'],
  ])('%s: %s is its own address, as written', (_, address) => {
    expect(emailKey(address)).toBe(address);
    expect(emailKey(address)).not.toBe(emailKey('a@xn--tda.example'));
  });

  it('still reads a Unicode domain as its canonical A-label', () => {
    expect(emailKey('a@ü.example')).toBe('a@xn--tda.example');
    expect(emailKey('a@Ü.example')).toBe('a@xn--tda.example');
  });
});

describe('punycode refuses a label RFC 3492 does', () => {
  it('reads nothing from a label whose only delimiter comes first (§6.2)', () => {
    expect(punycodeDecode('-tda')).toBeNull();
    expect(punycodeDecode('-abc')).toBeNull();
  });
});

describe('emailKey on all-ASCII domains (property)', () => {
  /** A seeded linear congruential generator: the same labels on every run. */
  function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }
  const CHARACTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-';
  function label(random: () => number): string {
    const length = 1 + Math.floor(random() * 8);
    const body = Array.from(
      { length },
      () => CHARACTERS[Math.floor(random() * CHARACTERS.length)],
    ).join('');
    return random() < 0.7 ? `xn--${body}` : body;
  }

  it('keeps every domain as written (case aside), so no two distinct ones share a key', () => {
    const random = seeded(199);
    const byKey = new Map<string, string>();
    for (let run = 0; run < 20_000; run++) {
      const domain = `${label(random)}.${random() < 0.5 ? label(random) : 'example'}`;
      const key = emailKey(`a@${domain}`);
      expect(key, domain).toBe(`a@${domain.toLowerCase()}`);
      const seen = byKey.get(key);
      if (seen !== undefined) expect(seen.toLowerCase(), domain).toBe(domain.toLowerCase());
      byKey.set(key, domain);
    }
  });
});
