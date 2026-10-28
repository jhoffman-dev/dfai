/*
 * Punycode (RFC 3492), the encoding of a Unicode domain label in ASCII:
 * `bücher` is `bcher-kva`. Kept here, rather than read from `URL` or Node's
 * `punycode`, because the mapper also runs as an n8n Code node and in
 * JavaScriptCore's shell, which has no `URL`, and the two must write the same
 * bytes (ADR-0034). Labels only: the `xn--` prefix is the caller's.
 */

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 0x80;
/** The largest integer RFC 3492 lets a decoder hold (§6.4); beyond it the text is not punycode. */
const MOST = 0x7fffffff;
const LAST_CODE_POINT = 0x10ffff;
const SURROGATES = { from: 0xd800, to: 0xdfff };

/** The threshold of the `k`th digit of a variable-length integer (§6.1). */
const threshold = (k: number, bias: number): number =>
  k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;

/** The bias for the next integer, from the last delta (§6.1). */
function adapt(delta: number, points: number, first: boolean): number {
  let scaled = first ? Math.floor(delta / DAMP) : Math.floor(delta / 2);
  scaled += Math.floor(scaled / points);
  let k = 0;
  while (scaled > ((BASE - T_MIN) * T_MAX) / 2) {
    scaled = Math.floor(scaled / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * scaled) / (scaled + SKEW));
}

/** A digit as written: 0–25 are `a`–`z`, 26–35 are `0`–`9`. */
const digitText = (digit: number): string =>
  String.fromCharCode(digit < 26 ? 0x61 + digit : 0x30 + digit - 26);

/** A written digit's value, either case; BASE for a character that is no digit. */
function digitValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 26;
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61;
  return BASE;
}

/** `delta` as a variable-length integer (§6.3). */
function integerText(delta: number, bias: number): string {
  let text = '';
  let rest = delta;
  for (let k = BASE; ; k += BASE) {
    const t = threshold(k, bias);
    if (rest < t) return text + digitText(rest);
    text += digitText(t + ((rest - t) % (BASE - t)));
    rest = Math.floor((rest - t) / (BASE - t));
  }
}

/** A label in punycode: its ASCII kept in order, then where each other character goes. */
export function punycodeEncode(label: string): string {
  const points = Array.from(label, (each) => each.codePointAt(0) ?? 0);
  const basic = points.filter((each) => each < INITIAL_N);
  let text = String.fromCharCode(...basic) + (basic.length > 0 ? '-' : '');
  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;
  for (let handled = basic.length; handled < points.length; delta++, n++) {
    const next = Math.min(...points.filter((each) => each >= n));
    delta += (next - n) * (handled + 1);
    n = next;
    for (const point of points) {
      if (point < n) delta++;
      if (point !== n) continue;
      text += integerText(delta, bias);
      bias = adapt(delta, handled + 1, handled === basic.length);
      delta = 0;
      handled++;
    }
  }
  return text;
}

/** One variable-length integer read from `text` at `at`, or null where none can be (§6.2). */
function readInteger(
  text: string,
  at: number,
  bias: number,
): { value: number; next: number } | null {
  let value = 0;
  let weight = 1;
  for (let k = BASE, pos = at; pos < text.length; k += BASE) {
    const digit = digitValue(text.charCodeAt(pos++));
    if (digit >= BASE) return null;
    value += digit * weight;
    const t = threshold(k, bias);
    if (digit < t) return value > MOST ? null : { value, next: pos };
    weight *= BASE - t;
    if (value > MOST || weight > MOST) return null;
  }
  return null;
}

const isCodePoint = (n: number) =>
  n <= LAST_CODE_POINT && (n < SURROGATES.from || n > SURROGATES.to);

/** The label a punycode text encodes, or null for text that is not punycode. */
export function punycodeDecode(text: string): string | null {
  // §6.2: the last delimiter ends the basic code points only when some come before it.
  const delimiter = text.lastIndexOf('-');
  const basic = delimiter > 0 ? text.slice(0, delimiter) : '';
  if (/\P{ASCII}/u.test(basic)) return null;
  const points = Array.from(basic, (each) => each.codePointAt(0) ?? 0);
  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;
  for (let at = delimiter > 0 ? delimiter + 1 : 0; at < text.length; i++) {
    const read = readInteger(text, at, bias);
    if (read === null) return null;
    const before = i;
    i += read.value;
    at = read.next;
    const length = points.length + 1;
    bias = adapt(i - before, length, before === 0);
    n += Math.floor(i / length);
    i %= length;
    if (!isCodePoint(n)) return null;
    points.splice(i, 0, n);
  }
  return String.fromCodePoint(...points);
}
