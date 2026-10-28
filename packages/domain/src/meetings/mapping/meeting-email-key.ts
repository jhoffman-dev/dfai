import { punycodeDecode, punycodeEncode } from './meeting-punycode.ts';

/*
 * How two email addresses are compared, everywhere DFAI compares them
 * (#199): Person matching, merges and the possible-duplicates list, the
 * owner's `selfEmails`, the Granola "me" check, group addresses. Here, in the
 * mapper's folder, because n8n's Code node and the app's pull both run it and
 * must decide alike (ADR-0034). Only comparisons use the key: a file keeps an
 * address as it was written (ADR-0003).
 *
 * The key of an address:
 * - its `<…>` part, when written as a mail client copies it (`Mara Quill <mara@example.com>`);
 * - the spaces round it set aside;
 * - in lower case, local part too: an address's local part may be
 *   case-sensitive by RFC 5321, but every provider a meeting comes from reads
 *   it without case, and DFAI has always compared it so;
 * - composed (NFC), as Granola and calendars send it;
 * - its domain in the ASCII (punycode) form DNS uses, with no final dot
 *   ({@link domainKey}); an all-ASCII domain is kept as written, case aside;
 * - a `+tag` kept: `mara+payroll@` is its own address here.
 */

/** IDNA's full stops other than `.` (UTS #46): `bücher。example` is `bücher.example`. */
const OTHER_FULL_STOPS = /[。．｡]/gu;
/** What a domain may not hold: it would be another part of a URL, or no host at all. */
const NOT_A_HOST = /[\s/?#:@[\]\\%\p{Cc}]/u;
const ASCII = /^\p{ASCII}*$/u;
const ACE_PREFIX = 'xn--';
const BRACKETED = /<([^<>]*)>\s*$/u;

const folded = (text: string): string => text.trim().toLowerCase().normalize('NFC');

/**
 * A label in its ASCII form: a Unicode one encoded. An `xn--` one is kept as
 * written, and only when it is the canonical A-label of a folded Unicode
 * label: one that is not (`xn--wca` is Ü, `xn---tda` breaks RFC 3492) is
 * another DNS label, so null — the domain is compared as written, never
 * folded onto another (PR #604 review).
 */
function asciiLabel(label: string): string | null {
  if (!ASCII.test(label)) return ACE_PREFIX + punycodeEncode(label);
  if (!label.startsWith(ACE_PREFIX)) return label;
  const encoded = label.slice(ACE_PREFIX.length);
  const decoded = punycodeDecode(encoded);
  const canonical =
    decoded !== null &&
    !ASCII.test(decoded) &&
    !NOT_A_HOST.test(decoded) &&
    folded(decoded) === decoded &&
    punycodeEncode(decoded) === encoded;
  return canonical ? label : null;
}

/**
 * A domain as two are compared: folded, its final dot dropped, and each label
 * in its ASCII (punycode) form — `Bücher.Example.` is `xn--bcher-kva.example`.
 * A domain that cannot be a host, or holds an `xn--` label that is not
 * punycode, is left folded as written: compared as itself, never as another.
 */
export function domainKey(written: string): string {
  const domain = folded(written).replace(OTHER_FULL_STOPS, '.').replace(/\.$/u, '');
  if (NOT_A_HOST.test(domain)) return domain;
  const labels = domain.split('.').map(asciiLabel);
  return labels.includes(null) ? domain : labels.join('.');
}

/** An address as two are compared: the same key is the same address (see above). */
export function emailKey(written: string): string {
  const address = folded(BRACKETED.exec(written)?.[1] ?? written);
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return address;
  return `${address.slice(0, at)}@${domainKey(address.slice(at + 1))}`;
}
