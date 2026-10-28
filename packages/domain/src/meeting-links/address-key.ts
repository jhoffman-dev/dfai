import { domainKey, emailKey } from '../meetings/mapping/meeting-email-key.ts';

/**
 * How an email address is compared, everywhere a person is found by one —
 * meeting import, a merge of people, the possible-duplicates list (#464) —
 * so a merge never keeps an address import would read as another, nor drops
 * one it would read as theirs. The address itself is {@link emailKey} (#199).
 */

/**
 * A company's domain or site as written in a note: `@`, `www.`, a scheme, a
 * path and a port dropped, and the rest as {@link domainKey} compares it.
 * Never a mail domain's key: `www.larkspur.example` is another mail domain.
 */
export function hostKey(written: string): string {
  const host = written
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//u, '')
    .replace(/[/?#].*$/u, '')
    .replace(/:\d*$/u, '')
    .replace(/^@/u, '')
    .replace(/^www\./u, '');
  return domainKey(host);
}

/** An address split for comparing: its local part, its `+tag` dropped, and its domain, both folded. */
export interface AddressParts {
  readonly local: string;
  readonly domain: string;
}

/** {@link AddressParts} of an address, or null for text with no `@` or nothing either side. */
export function addressParts(written: string): AddressParts | null {
  const address = emailKey(written);
  const at = address.lastIndexOf('@');
  if (at <= 0) return null;
  const local = (address.slice(0, at).split('+')[0] ?? '').trim();
  const domain = domainKey(address.slice(at + 1));
  return local === '' || domain === '' ? null : { local, domain };
}

/**
 * The mailbox an address reaches, its `+tag` dropped: `mara+payroll@larkspur.example`
 * is `mara@larkspur.example`. What finds a person when no address of theirs
 * is written exactly so. Null for text that is not an address.
 */
export function untaggedAddressKey(written: string): string | null {
  const parts = addressParts(written);
  return parts === null ? null : `${parts.local}@${parts.domain}`;
}
