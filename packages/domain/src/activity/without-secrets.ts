/*
 * Secret values never reach TypeScript on purpose — the host fills them in and
 * strikes them from what comes back (`secrets/redact.rs`). But an error's words
 * come from anywhere: a server echoing a header, a URL with a key in its query.
 * The Activity log keeps lines for a month, so a value that slipped through
 * once would sit there; these patterns catch the shapes a secret arrives in,
 * and each asks for a shape a word of prose does not have.
 */

/** What a secret's value is struck to. */
export const REDACTED = '<secret>';

/** `Bearer abc…`, `Token: abc…`: an Authorization header's value. */
const SCHEME = /\b(Bearer|Token)(\s*:\s*|\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * `Basic dXNl…`: base64 of a name and password. It must look like base64 — a
 * digit, `+`, `/` or `=` in it, or mixed case past its first letter — because
 * `Basic information` is prose.
 */
const BASIC =
  /\b([Bb]asic|BASIC)(\s*:\s*|\s+)(?=[A-Za-z0-9+/=]*(?:[0-9+/=]|[a-z][A-Z]))[A-Za-z0-9+/=]{8,}/g;

/** The names a secret's value is given, `api key` and `api_key` alike. */
const SECRET_NAME =
  'authorization|set-cookie|cookie|x-api-key|api[-_ ]?key|access[-_ ]?(?:token|key(?:[-_ ]?id)?)|secret[-_ ]?(?:access[-_ ]?)?key|private[-_ ]?key|refresh[-_ ]?token|auth[-_ ]?token|session[-_ ]?(?:id|token)|client[-_ ]?secret|token|secret|password|passwd';

/** `"api_key": "correct horse battery staple"`: a quoted value, taken whole. */
const NAMED_QUOTED = new RegExp(
  `(?<!\\{\\{\\s*)\\b(${SECRET_NAME})(["']?\\s*[:=]\\s*)(["'])(?!<secret>)(?:(?!\\3)[^\\n])*\\3`,
  'gi',
);

/**
 * `api_key=…`, `Cookie: session=…`, `Authorization: …`: a value named as a
 * secret, up to a space, quote or separator. Not `{{secret:github}}`, which
 * names a secret without holding it.
 */
const NAMED = new RegExp(
  `(?<!\\{\\{\\s*)\\b(${SECRET_NAME})(["']?\\s*[:=]\\s*["']?)(?!<secret>)[^\\s"'&,;]+`,
  'gi',
);

/** Keys whose shape gives them away: Anthropic/OpenAI, GitHub, Slack, AWS, Google. */
const KNOWN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g;

/** A long run of letters and digits in both cases: how a random token looks, and a word or slug does not. */
const TOKEN_LIKE = /\b[A-Za-z0-9_-]{32,}\b/g;

/** An AWS secret access key: forty characters of base64, `/` and `+` included. */
const AWS_SECRET = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;

/**
 * A long lower-case hex run: an API key or session id in hex. One the message
 * names as a digest or commit (`sha 3f78…`) is left, as it is not a secret.
 */
const HEX_TOKEN = /(?<!\b(?:sha(?:1|256|512)?|digest|hash|commit|etag)[\s:=]+)\b[0-9a-f]{24,}\b/gi;

/** The text with every value that looks like a secret replaced by `<secret>`. */
export function withoutSecrets(text: string): string {
  return text
    .replace(SCHEME, (_match, scheme: string, joiner: string) => `${scheme}${joiner}${REDACTED}`)
    .replace(BASIC, (_match, scheme: string, joiner: string) => `${scheme}${joiner}${REDACTED}`)
    .replace(NAMED_QUOTED, (_match, name: string, joiner: string, quote: string) => {
      return `${name}${joiner}${quote}${REDACTED}${quote}`;
    })
    .replace(NAMED, (_match, name: string, joiner: string) => `${name}${joiner}${REDACTED}`)
    .replace(KNOWN, REDACTED)
    .replace(AWS_SECRET, (run) => (looksRandom(run) ? REDACTED : run))
    .replace(TOKEN_LIKE, (run) => (looksRandom(run) ? REDACTED : run))
    .replace(HEX_TOKEN, (run) => (looksHex(run) ? REDACTED : run));
}

function looksRandom(run: string): boolean {
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run);
}

/** Hex in one case, with digits and letters both: not a word, not a number. */
function looksHex(run: string): boolean {
  return (
    (run === run.toLowerCase() || run === run.toUpperCase()) &&
    /[0-9]/.test(run) &&
    /[a-f]/i.test(run)
  );
}
