import type { MeetingAttendee } from '../meetings/meeting-header.ts';
import { emailKey } from '../meetings/mapping/meeting-email-key.ts';
import { hostKey, untaggedAddressKey } from './address-key.ts';
import { vocabularyKey } from '../terms/spelling.ts';
import type { VaultPath } from '../vault/vault-path.ts';

/** A person in the vault, as matching reads their note. */
export interface DirectoryPerson {
  readonly path: VaultPath;
  /** Their note's title. */
  readonly name: string;
  /** `email` and every item of `other_emails`, as written. */
  readonly emails: readonly string[];
  readonly aliases: readonly string[];
  /** The company their note's `company` links, resolved; null when it links none. */
  readonly company: VaultPath | null;
}

/** A company in the vault, as matching reads its note. */
export interface DirectoryCompany {
  readonly path: VaultPath;
  readonly name: string;
  readonly aliases: readonly string[];
  /** Every item of `domains`, and the host of `site`, as written. */
  readonly domains: readonly string[];
}

/** How an attendee was found among the people. */
export type MatchedBy = 'email' | 'name' | 'alias';

export interface LinkedAttendee {
  readonly attendee: MeetingAttendee;
  readonly person: DirectoryPerson;
  readonly by: MatchedBy;
}

/** An attendee more than one person could be: proposed, never guessed. */
export interface AmbiguousAttendee {
  readonly attendee: MeetingAttendee;
  readonly candidates: readonly DirectoryPerson[];
  readonly by: MatchedBy;
  /**
   * The one person of that name has addresses on file, and none is this
   * attendee's: the same name, but perhaps not the same person.
   */
  readonly differentAddress?: boolean;
}

/** An attendee no person matches, with the company their address surely belongs to, if any. */
export interface UnknownAttendee {
  readonly attendee: MeetingAttendee;
  readonly company: DirectoryCompany | null;
}

/**
 * A company only the name of an attendee's domain points at: `fenn.example`
 * for "Fenn". Likely, not sure: a person confirms it, so it is never written.
 */
export interface GuessedCompany {
  readonly company: DirectoryCompany;
  /** The first attendee whose address pointed at it. */
  readonly attendee: MeetingAttendee;
}

/** A company the meeting surely involves, and why. */
export interface MatchedCompany {
  readonly company: DirectoryCompany;
  /** An attendee's address is at its domain, or a linked person's note names it. */
  readonly by: 'domain' | 'person';
}

export interface AttendeeMatching {
  /** One per person, in the order they were first listed. */
  readonly linked: readonly LinkedAttendee[];
  readonly unknown: readonly UnknownAttendee[];
  /** Group addresses: kept, never a person (ADR-0027). */
  readonly groups: readonly MeetingAttendee[];
  readonly ambiguous: readonly AmbiguousAttendee[];
  readonly companies: readonly MatchedCompany[];
  /** Companies named only by a domain's name, each once; none that is surely involved already. */
  readonly guessedCompanies: readonly GuessedCompany[];
}

/**
 * Who a meeting's attendees are among the vault's people and companies
 * (P29-04). An attendee is matched by email first — `email` or any of
 * `other_emails`, case aside — and only when their address matches nobody, by
 * name: a person's name or one of their aliases, spelt the way the Terms page
 * compares spellings (composed, single-spaced, case folded). Exactly one
 * person is a link; two or more are ambiguous, which is proposed rather than
 * guessed; none is unknown. A group address is never a person.
 *
 * An attendee whose name is exactly one person's, but whose address is not
 * one that person has on file, is ambiguous rather than linked: it may be
 * someone else of the same name.
 *
 * A company is involved when an attendee's address — a group's too — is at a
 * domain it declares (the most specific one wins, so a subsidiary is not its
 * parent; two claiming the same one claim nothing), and when a linked
 * person's note names their company. A domain whose name is the company's
 * name or alias (`larkspur.example` for "Larkspur") only *guesses* it, and
 * only for a company that declares no domain of its own.
 */
export function matchAttendees(
  attendees: readonly MeetingAttendee[],
  people: readonly DirectoryPerson[],
  companies: readonly DirectoryCompany[],
): AttendeeMatching {
  const findPerson = personFinder(people);
  const finder = companyFinder(companies);
  const linked = new Map<VaultPath, LinkedAttendee>();
  const unknown: UnknownAttendee[] = [];
  const ambiguous: AmbiguousAttendee[] = [];
  const heard = new Set<string>();
  // Listed once with an address and once without, they are one person: the address is kept.
  const addressed = new Set(
    attendees.flatMap((each) => (each.email === null ? [] : [vocabularyKey(each.name)])),
  );
  for (const attendee of attendees) {
    const key = attendeeKey(attendee);
    if (attendee.group || heard.has(key)) continue;
    if (attendee.email === null && addressed.has(vocabularyKey(attendee.name))) continue;
    heard.add(key);
    const found = findPerson(attendee);
    const [person, ...others] = found?.candidates ?? [];
    if (found === null || person === undefined) {
      unknown.push({ attendee, company: finder.declared(attendee.email) });
    } else if (others.length > 0) {
      ambiguous.push({ attendee, ...found });
    } else if (hasOtherAddress(attendee, person, found.by)) {
      ambiguous.push({ attendee, ...found, differentAddress: true });
    } else if (!linked.has(person.path)) {
      linked.set(person.path, { attendee, person, by: found.by });
    }
  }
  const involved = involvedCompanies({
    attendees,
    linked: [...linked.values()],
    companies,
    declared: finder.declared,
  });
  return {
    linked: [...linked.values()],
    unknown,
    groups: attendees.filter((attendee) => attendee.group),
    ambiguous,
    companies: involved,
    guessedCompanies: guessedCompanies({ attendees, involved, named: finder.named }),
  };
}

/** Whether an attendee has an address, and the person has some on file, none the same. */
function hasOtherAddress(attendee: MeetingAttendee, person: DirectoryPerson, by: MatchedBy) {
  return by !== 'email' && attendee.email !== null && person.emails.length > 0;
}

/**
 * The people named speakers surely are: a speaker's name, or alias, that
 * exactly one person has. One that matches nobody, or several, is left: a
 * speaker has no address to tell them apart, and the attendees are what
 * proposals are made from.
 */
export function matchSpeakers(
  names: readonly string[],
  people: readonly DirectoryPerson[],
): DirectoryPerson[] {
  const byName = nameIndex(people);
  const found = new Map<VaultPath, DirectoryPerson>();
  for (const name of names) {
    const [only, ...others] = byName.get(vocabularyKey(name)) ?? [];
    if (only !== undefined && others.length === 0) found.set(only.person.path, only.person);
  }
  return [...found.values()];
}

/** The part of an address after its last `@`, lower-cased; null for no address or no domain. */
export function emailDomain(email: string | null): string | null {
  if (email === null) return null;
  const at = email.lastIndexOf('@');
  const domain = hostKey(email.slice(at + 1));
  return at < 0 || domain === '' ? null : domain;
}

/**
 * The organisation label (`gmail` in `gmail.co.uk`, `outlook` in `outlook.de`)
 * of mail providers whose name is theirs alone: their other countries are
 * caught without listing each.
 */
const PUBLIC_MAIL_LABELS: ReadonlySet<string> = new Set([
  'aol',
  'btinternet',
  'fastmail',
  'gmail',
  'gmx',
  'googlemail',
  'hotmail',
  'icloud',
  'msn',
  'outlook',
  'proton',
  'protonmail',
  'rediffmail',
  'rocketmail',
  'tuta',
  'tutanota',
  'yahoo',
  'ymail',
  'yandex',
]);

/**
 * Providers whose name is also an everyday word (`live`, `web`, `orange`), or
 * a company's own, matched only as these exact domains so a company at
 * `web.example` is not taken for a mail host.
 */
const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'att.net',
  'bellsouth.net',
  'comcast.net',
  'freenet.de',
  'hey.com',
  'laposte.net',
  'live.ca',
  'live.co.uk',
  'live.com',
  'live.com.au',
  'live.de',
  'live.fr',
  'live.it',
  'live.nl',
  'mac.com',
  'mail.com',
  'mailbox.org',
  'me.com',
  'naver.com',
  'orange.fr',
  'pm.me',
  'qq.com',
  'sbcglobal.net',
  'verizon.net',
  'wanadoo.fr',
  'web.de',
]);

/**
 * Hosts a company's site may be on that are not its own — a profile page or a
 * subdomain on one (`acme.zendesk.com`, `acme.github.io`) is no claim to
 * everyone with an address there.
 */
const SHARED_HOSTS: readonly string[] = [
  'atlassian.net',
  'blogspot.com',
  'bsky.app',
  'carrd.co',
  'crunchbase.com',
  'docs.google.com',
  'drive.google.com',
  'facebook.com',
  'freshdesk.com',
  'github.com',
  'github.io',
  'gitlab.com',
  'gitlab.io',
  'glassdoor.com',
  'herokuapp.com',
  'instagram.com',
  'linkedin.com',
  'linktr.ee',
  'medium.com',
  'myshopify.com',
  'netlify.app',
  'notion.site',
  'notion.so',
  'pages.dev',
  'pinterest.com',
  'sites.google.com',
  'squarespace.com',
  'substack.com',
  'tiktok.com',
  'twitter.com',
  'vercel.app',
  'webflow.io',
  'wixsite.com',
  'wordpress.com',
  'workers.dev',
  'x.com',
  'youtu.be',
  'youtube.com',
  'zendesk.com',
];

/** Whether a domain is a public mail provider's, in any country. */
export function isPublicMail(domain: string): boolean {
  return PUBLIC_MAIL_DOMAINS.has(domain) || PUBLIC_MAIL_LABELS.has(organisationLabel(domain));
}

function isSharedHost(host: string): boolean {
  return SHARED_HOSTS.some((shared) => host === shared || host.endsWith(`.${shared}`));
}

/**
 * Whether a domain or site a company names is its own, rather than anyone's:
 * not a public mail provider's, not a shared host, and — for a site — not a
 * page below the root, which says where the company is, not whose domain it is.
 */
function ownDomain(written: string): boolean {
  const host = hostKey(written);
  return host !== '' && isRootSite(written) && !isPublicMail(host) && !isSharedHost(host);
}

/** Whether a written site has no path past the host (`https://acme.example/` or bare). */
function isRootSite(written: string): boolean {
  const afterScheme = written.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const path = /^[^/?#]*(\/[^?#]*)?/.exec(afterScheme)?.[1] ?? '';
  return path.replace(/\//g, '') === '';
}

/** Second-level labels under a country's domain: `larkspur` in `larkspur.co.uk`, not `co`. */
const SHARED_SECOND_LEVELS: ReadonlySet<string> = new Set(['ac', 'co', 'com', 'gov', 'net', 'org']);

interface PersonFound {
  readonly candidates: readonly DirectoryPerson[];
  readonly by: MatchedBy;
}

interface NamedPerson {
  readonly person: DirectoryPerson;
  readonly by: 'name' | 'alias';
}

function personFinder(people: readonly DirectoryPerson[]) {
  const byEmail = addressIndex(people, emailKey);
  // A `+tag` reaches the same mailbox: found by it only when no address is written exactly so.
  const byMailbox = addressIndex(people, untaggedAddressKey);
  const byName = nameIndex(people);
  return (attendee: MeetingAttendee): PersonFound | null => {
    const email = attendee.email;
    const exact = email === null ? [] : (byEmail.get(emailKey(email)) ?? []);
    const mailed =
      exact.length > 0 || email === null
        ? exact
        : (byMailbox.get(untaggedAddressKey(email) ?? '') ?? []);
    if (mailed.length > 0) return { candidates: mailed, by: 'email' };
    const named = byName.get(vocabularyKey(attendee.name)) ?? [];
    if (named.length === 0) return null;
    return {
      candidates: named.map(({ person }) => person),
      by: named.every(({ by }) => by === 'alias') ? 'alias' : 'name',
    };
  };
}

/**
 * Each address — `email`, `other_emails`, and an alias written as one, which
 * a person may keep an old address in (#464) — by `key`, and the people
 * holding it, each person once.
 */
function addressIndex(
  people: readonly DirectoryPerson[],
  key: (written: string) => string | null,
): Map<string, DirectoryPerson[]> {
  const index = new Map<string, DirectoryPerson[]>();
  for (const person of people) {
    const addresses = [...person.emails, ...person.aliases.filter(isWrittenAddress)];
    for (const each of new Set(addresses.map(key))) {
      if (each === null || each === '') continue;
      index.set(each, [...(index.get(each) ?? []), person]);
    }
  }
  return index;
}

/** Each spelling — a name or an alias — and the people it names, each person once. */
function nameIndex(people: readonly DirectoryPerson[]): Map<string, NamedPerson[]> {
  const byName = new Map<string, NamedPerson[]>();
  const add = (form: string, named: NamedPerson) => {
    const key = vocabularyKey(form);
    const known = byName.get(key) ?? [];
    if (key === '' || known.some(({ person }) => person.path === named.person.path)) return;
    byName.set(key, [...known, named]);
  };
  for (const person of people) {
    add(person.name, { person, by: 'name' });
    for (const alias of person.aliases) add(alias, { person, by: 'alias' });
  }
  return byName;
}

interface CompanyFinder {
  /** The company whose declared domain an address is at, the most specific one; null for none, or a tie. */
  readonly declared: (email: string | null) => DirectoryCompany | null;
  /** The company only the name of an address's domain points at: never one that declares a domain. */
  readonly named: (email: string | null) => DirectoryCompany | null;
}

function companyFinder(companies: readonly DirectoryCompany[]): CompanyFinder {
  const claims = companies.flatMap((company) =>
    company.domains.filter(ownDomain).map((written) => ({ company, host: hostKey(written) })),
  );
  const declares = new Set(claims.map(({ company }) => company.path));
  const claimsOn = (domain: string) => claims.filter(({ host }) => withinDomain(domain, host));
  return {
    declared: (email) => {
      const domain = emailDomain(email);
      if (domain === null) return null;
      const matching = claimsOn(domain);
      const specificity = Math.max(0, ...matching.map(({ host }) => host.split('.').length));
      const best = matching.filter(({ host }) => host.split('.').length === specificity);
      return onlyOne([...new Map(best.map(({ company }) => [company.path, company])).values()]);
    },
    named: (email) => {
      const domain = emailDomain(email);
      // A domain someone declares is answered by `declared`, even when that is a tie.
      if (domain === null || isPublicMail(domain) || claimsOn(domain).length > 0) return null;
      const label = compact(organisationLabel(domain));
      if (label === '') return null;
      return onlyOne(
        companies.filter(
          (company) =>
            !declares.has(company.path) &&
            [company.name, ...company.aliases].some((form) => compact(form) === label),
        ),
      );
    },
  };
}

function onlyOne<T>(found: readonly T[]): T | null {
  return found.length === 1 ? (found[0] ?? null) : null;
}

function involvedCompanies({
  attendees,
  linked,
  companies,
  declared,
}: {
  attendees: readonly MeetingAttendee[];
  linked: readonly LinkedAttendee[];
  companies: readonly DirectoryCompany[];
  declared: CompanyFinder['declared'];
}): MatchedCompany[] {
  const involved = new Map<VaultPath, MatchedCompany>();
  for (const { email } of attendees) {
    const company = declared(email);
    if (company !== null && !involved.has(company.path)) {
      involved.set(company.path, { company, by: 'domain' });
    }
  }
  for (const { person } of linked) {
    const company = companies.find((candidate) => candidate.path === person.company);
    if (company !== undefined && !involved.has(company.path)) {
      involved.set(company.path, { company, by: 'person' });
    }
  }
  return [...involved.values()];
}

function guessedCompanies({
  attendees,
  involved,
  named,
}: {
  attendees: readonly MeetingAttendee[];
  involved: readonly MatchedCompany[];
  named: CompanyFinder['named'];
}): GuessedCompany[] {
  const sure = new Set(involved.map(({ company }) => company.path));
  const guessed = new Map<VaultPath, GuessedCompany>();
  for (const attendee of attendees) {
    const company = named(attendee.email);
    if (company !== null && !sure.has(company.path) && !guessed.has(company.path)) {
      guessed.set(company.path, { company, attendee });
    }
  }
  return [...guessed.values()];
}

/**
 * What makes two attendee entries one attendee: their address, or their name
 * when they have none. What a proposal for them is known by, too.
 */
export function attendeeKey(attendee: MeetingAttendee): string {
  return attendee.email === null
    ? `name:${vocabularyKey(attendee.name)}`
    : `email:${emailKey(attendee.email)}`;
}

/** Whether an alias is written as an address: something either side of one `@`, no spaces. */
function isWrittenAddress(alias: string): boolean {
  return /^[^\s@]+@[^\s@]+$/u.test(alias.trim());
}

/** Whether an address's domain is the company's, or one under it (`mail.larkspur.example`). */
function withinDomain(domain: string, companyDomain: string): boolean {
  return companyDomain !== '' && (domain === companyDomain || domain.endsWith(`.${companyDomain}`));
}

/** The label naming the organisation in a domain: `larkspur` in `mail.larkspur.example`. */
function organisationLabel(domain: string): string {
  const [top = '', second = '', third = ''] = domain.split('.').reverse();
  if (second === '') return top;
  const shared = third !== '' && top.length === 2 && SHARED_SECOND_LEVELS.has(second);
  return shared ? third : second;
}

/** A name with nothing but its letters and digits, to compare with a domain's label. */
function compact(form: string): string {
  return vocabularyKey(form).replace(/[^\p{L}\p{N}]/gu, '');
}
