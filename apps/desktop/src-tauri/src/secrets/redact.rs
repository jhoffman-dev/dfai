//! Striking every secret that went out from whatever came back.
//!
//! A server that echoes its request rarely echoes it byte for byte. It builds a
//! `next` link from the query it was sent, percent-encoding some characters and
//! not others, in upper or lower case, and sometimes twice; it form-encodes a
//! space as `+`; it quotes a header in JSON, escaping `"` and `\`, or every
//! character; it hands back a whole header — `Bearer <key>`, the credentials of
//! a Basic one — as base64. Each character of a secret is looked for as itself,
//! as `%XX` or `%25XX` in either case of hex, as a JSON `\uXXXX` or short
//! escape, and a space as `+`, so a value written in any mixture of those is
//! still found; so is its base64, in both alphabets, padded or not, at each of
//! the three alignments it can sit at.
//!
//! A secret of 8 characters or more is also read loosely. The answer is
//! decoded once, whatever the number of secrets — HTML numeric entities
//! (decimal or hex, any number of digits, the `;` optional), the five named
//! ones (`&amp;` `&lt;` `&gt;` `&quot;` `&apos;`), JSON's `\uXXXX` (a
//! surrogate pair as one character) and short escapes — and base64 wrapped
//! into lines is joined: a break of LF, CR or CRLF, as itself, JSON-escaped
//! or as entities, with the indent of a continuation line, between two
//! base64 characters. Each secret is looked for in that reading too, in any
//! case of its ASCII letters, and only the original text a match was read
//! from is struck, widened to whole entities and escapes, never the run
//! around it. A secret shorter than 8 characters is found only as it is and
//! in the escaped and base64 forms above: read loosely, a short one would
//! match ordinary text by chance and strike it.
//!
//! What is deliberately not looked for, and why that is acceptable:
//!
//! - hex, `\x` and `\u{…}` escapes, named entities past the five, a
//!   Unicode case-folded or NFD-normalised copy, base64 of the
//!   percent-encoded value, a percent- or `\u`-escaped copy in another case,
//!   base64 wrapped by a blank line or text between its lines, and an echo
//!   cut short.
//!
//! Each is a server going out of its way to transform what it was sent, and
//! every form added makes every secret's matcher larger and slower. The
//! redactor is defence in depth: what keeps a secret safe is that it is only
//! ever sent where it is pinned or bound to go (ADR-0017), so a server that
//! could echo it in one of these forms is one the person chose to give it to.
//!
//! Every match of every secret is collected before anything is replaced, and
//! matches that overlap are struck as one span: replacing a shorter secret first
//! would break up a longer one that contains it, and leave its remainder in the
//! clear.

use std::cmp::Reverse;
use std::collections::hash_map::RandomState;
use std::collections::VecDeque;
use std::hash::BuildHasher;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use base64::engine::general_purpose::{
    GeneralPurpose, STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD,
};
use base64::Engine;
use regex::{Regex, RegexBuilder};

mod decoded;

use decoded::Decoded;

/// Handed back in place of a response that could not be checked. Nothing is
/// better than something that might hold a secret.
const UNCHECKED: &str = "[the response could not be checked for secrets, so it is not shown]";

/// What one secret's matcher may take, which bounds what building it costs
/// and so how long a secret DFAI keeps may be: a value whose matcher will
/// not build within it is refused when it is saved, and never sent. Every
/// character may be written several ways, so what fits depends on which
/// characters they are — measured at this limit (review of PR #631): 2,640
/// bytes of printable ASCII in no order, a signed token's letters, digits,
/// `-`, `_` and `.` to 3,399 bytes and past, 5,010 of `€` and 5,091 of CJK.
/// Near its end a token fits or not by its length (how its base64 forms
/// align). Raised from 12 MiB when the value in another case was added to
/// the matcher of every secret read loosely (attack on PR #631), so that no
/// secret kept before is refused now
/// (`every_secret_length_that_built_before_still_builds`). With
/// `HELD_AT_MOST` matchers held, the most they take is 112 MiB, where it was
/// 96.
const MATCHER_SIZE_LIMIT: usize = 14 * 1024 * 1024;

/// A value longer than this is refused without trying to build its matcher.
/// Building one writes and parses the whole pattern before the size limit is
/// reached, which takes seconds for a value of a few times this; and no value
/// of more than some 5.1 KB (5,091 bytes of CJK, 5,010 of `€`) has been seen
/// to fit `MATCHER_SIZE_LIMIT`, so this refuses nothing that would build.
const NEVER_BUILDS_PAST: usize = 6 * 1024;

/// How many values' matchers are held at once.
const HELD_AT_MOST: usize = 8;

/// A secret whose matcher would not build within `MATCHER_SIZE_LIMIT`: it
/// could not be struck from what comes back, so it is neither kept nor sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TooLongToProtect;

/// A secret shorter than this is not read loosely (`read_loosely`).
const SHORTEST_READ_LOOSELY: usize = 8;

/// A secret shorter than this is not looked for as base64: the base64 of one
/// or two bytes is a character or two, which ordinary text is full of.
const SHORTEST_FOR_BASE64: usize = 8;

/// Replaces every secret that went into a request wherever it appears in what
/// came back, in any of the forms described above.
pub fn redact(text: &str, used: &[(String, String)]) -> String {
    let used: Vec<&(String, String)> = used.iter().filter(|(_, value)| !value.is_empty()).collect();
    // Read once, before any secret is looked for, and only for one long
    // enough to be read loosely.
    let decoded = used
        .iter()
        .any(|(_, value)| read_loosely(value))
        .then(|| decoded_once(text))
        .flatten();
    let mut found: Vec<(usize, usize, &str)> = Vec::new();
    for (name, value) in used {
        let Ok(matcher) = matchers().for_value(value, matcher) else {
            return UNCHECKED.to_string();
        };
        found.extend(scanned(&matcher, text).map(|(start, end)| (start, end, name.as_str())));
        if let Some(decoded) = decoded.as_ref().filter(|_| read_loosely(value)) {
            found.extend(
                scanned(&matcher, decoded.text())
                    .map(|(start, end)| decoded.original_span(start, end))
                    .map(|(start, end)| (start, end, name.as_str())),
            );
        }
    }
    strike(text, found)
}

/// A secret is read loosely — decoded from entities and escapes, across
/// wrapped lines, and in another case — only when it is long enough that a
/// chance match in ordinary text is not likely. A shorter one is found only
/// as it is and in the escaped and base64 forms it always was, so a short
/// named secret never strikes a word that merely looks like it.
fn read_loosely(value: &str) -> bool {
    value.chars().count() >= SHORTEST_READ_LOOSELY
}

fn decoded_once(text: &str) -> Option<Decoded> {
    #[cfg(test)]
    DECODES.with(|count| count.set(count.get() + 1));
    Decoded::of(text, decoded::Layers::ALL)
}

/// Every match of `matcher` in `text`, as byte spans.
fn scanned<'a>(matcher: &'a Regex, text: &'a str) -> impl Iterator<Item = (usize, usize)> + 'a {
    #[cfg(test)]
    SCANNED_BYTES.with(|count| count.set(count.get() + text.len()));
    matcher.find_iter(text).map(|at| (at.start(), at.end()))
}

/// Builds the matcher that strikes `value`, unless it is already held, so
/// that a value it cannot be built for is refused before it is kept or sent
/// rather than discovered in an answer that then has to be withheld. From an
/// async command, use `ensure_strikable_off_worker`: a build can take most of
/// a second.
pub fn ensure_strikable(value: &str) -> Result<(), TooLongToProtect> {
    matchers().for_value(value, matcher).map(drop)
}

/// `ensure_strikable`, on a thread kept for blocking work. A check that
/// cannot finish there is a value that is not known to be strikable, and is
/// refused.
pub async fn ensure_strikable_off_worker(value: String) -> Result<(), TooLongToProtect> {
    on_blocking_thread(move || ensure_strikable(&value), Err(TooLongToProtect)).await
}

/// Whether a matcher for `value` is held, without counting as a use of it.
#[cfg(test)]
pub fn holds_matcher(value: &str) -> bool {
    matchers().holds(value)
}

/// `redact`, on a thread kept for blocking work. Matching a long secret
/// against a large answer built to resemble it takes seconds — two, for a
/// 1,024-byte secret and 16 MB — and on an async worker that would stall
/// every other command, and the local API server, for as long.
pub async fn redact_off_worker(text: String, used: Vec<(String, String)>) -> String {
    on_blocking_thread(move || redact(&text, &used), UNCHECKED.to_string()).await
}

/// Runs `work` on a thread kept for blocking work, so that building a
/// matcher — most of a second for a long secret in a debug build — never
/// stalls an async worker, every other command and the local API server with
/// it. Work that cannot finish there (it panicked, or the runtime is shutting
/// down) answers `failed`, which is always the refusal: nothing is better
/// than something that might hold a secret.
pub async fn on_blocking_thread<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
    failed: T,
) -> T {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or(failed)
}

/// The matchers built in this run, for the values most recently used.
fn matchers() -> &'static Matchers {
    static MATCHERS: OnceLock<Matchers> = OnceLock::new();
    MATCHERS.get_or_init(Matchers::default)
}

/// A value's matcher, or that it would not build.
type Built = Result<Arc<Regex>, TooLongToProtect>;

/// The matchers of the `HELD_AT_MOST` values used most recently, each held
/// by the value's fingerprint, the least recently used first.
///
/// What is held is the compiled matcher, whose pattern spells the value out
/// in every form it is looked for in: holding it is holding the value, in
/// this process's memory. Up to 8 recently used values' matchers stay in
/// memory until other values displace them or the app quits. Deleting a
/// secret, forgetting the Granola key, or refusing a value when it is saved
/// does not drop its matcher; and memory let go of is not wiped. A value
/// whose matcher would not build is held as that failure, within the same
/// bound, so a request that names it again soon is refused at once rather
/// than building it again.
///
/// Held by value rather than by secret name, so a name that is deleted,
/// renamed or given a new value leaves nothing behind that the bound does
/// not count. A fingerprint is 64 bits of a hash keyed afresh in each run:
/// two values share one only by chance, and no one outside the run can pick
/// a value that does.
#[derive(Default)]
struct Matchers {
    recent: Mutex<VecDeque<(u64, Built)>>,
    fingerprints: RandomState,
}

impl Matchers {
    /// Every write is one whole push, removal or move, so a thread that
    /// panicked holding the lock cannot have left it half-changed.
    fn recent(&self) -> MutexGuard<'_, VecDeque<(u64, Built)>> {
        self.recent
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The matcher for `value`, built with `build` only when none is held for
    /// it. The build runs outside the lock, so one value's build never holds
    /// up another's match.
    fn for_value(
        &self,
        value: &str,
        build: impl FnOnce(&str) -> Result<Regex, TooLongToProtect>,
    ) -> Built {
        let fingerprint = self.fingerprints.hash_one(value);
        if let Some(held) = self.used_again(fingerprint) {
            return held;
        }
        let built = build(value).map(Arc::new);
        self.hold(fingerprint, built.clone());
        built
    }

    /// What is held for `fingerprint`, moved to the most recently used.
    fn used_again(&self, fingerprint: u64) -> Option<Built> {
        let mut recent = self.recent();
        let at = recent.iter().position(|(held, _)| *held == fingerprint)?;
        let entry = recent.remove(at)?;
        let built = entry.1.clone();
        recent.push_back(entry);
        Some(built)
    }

    /// Holds `built` as the most recently used, letting go of the least
    /// recently used past `HELD_AT_MOST`. A value built twice at once is held
    /// once.
    fn hold(&self, fingerprint: u64, built: Built) {
        let mut recent = self.recent();
        recent.retain(|(held, _)| *held != fingerprint);
        recent.push_back((fingerprint, built));
        while recent.len() > HELD_AT_MOST {
            recent.pop_front();
        }
    }

    #[cfg(test)]
    fn holds(&self, value: &str) -> bool {
        let fingerprint = self.fingerprints.hash_one(value);
        self.recent().iter().any(|(held, _)| *held == fingerprint)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.recent().len()
    }
}

/// Replaces each span, merging any that overlap into one. The earliest, longest
/// match names the merged span.
fn strike(text: &str, mut found: Vec<(usize, usize, &str)>) -> String {
    found.sort_by_key(|&(start, end, _)| (start, Reverse(end)));

    let mut struck = String::with_capacity(text.len());
    let mut kept_to = 0;
    let mut spans = found.into_iter().peekable();
    while let Some((start, mut end, name)) = spans.next() {
        while let Some(&(next_start, next_end, _)) = spans.peek() {
            if next_start >= end {
                break;
            }
            end = end.max(next_end);
            spans.next();
        }
        struck.push_str(&text[kept_to..start]);
        struck.push_str(&format!("[secret {name} removed]"));
        kept_to = end;
    }
    struck.push_str(&text[kept_to..]);
    struck
}

/// One secret in any of its forms, each of which may itself be escaped.
fn matcher(value: &str) -> Result<Regex, TooLongToProtect> {
    matcher_with(value, compiled)
}

/// `matcher`, built by `build`: a value past the ceiling never reaches it.
fn matcher_with(
    value: &str,
    build: impl FnOnce(&str) -> Result<Regex, regex::Error>,
) -> Result<Regex, TooLongToProtect> {
    if value.len() > NEVER_BUILDS_PAST {
        return Err(TooLongToProtect);
    }
    build(value).map_err(|_| TooLongToProtect)
}

// How many times an answer was decoded, and how many bytes the matchers
// read, on this thread: what redacting costs, counted rather than timed.
#[cfg(test)]
thread_local! {
    pub(super) static DECODES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    pub(super) static SCANNED_BYTES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// How many matchers were built, here and on this thread: a test tells a
/// build on the async worker from one on a thread kept for it by counting,
/// not by timing either (#403).
#[cfg(test)]
pub(super) static BUILT_ANYWHERE: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
#[cfg(test)]
thread_local! {
    pub(super) static BUILT_ON_THIS_THREAD: std::cell::Cell<usize> =
        const { std::cell::Cell::new(0) };
}

fn compiled(value: &str) -> Result<Regex, regex::Error> {
    #[cfg(test)]
    {
        BUILT_ANYWHERE.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        BUILT_ON_THIS_THREAD.with(|built| built.set(built.get() + 1));
    }
    RegexBuilder::new(&pattern(value))
        .size_limit(MATCHER_SIZE_LIMIT)
        .build()
}

/// What a value's matcher is built from: each of its forms, spelled every
/// way its characters are sent. Building writes and parses all of it before
/// the size limit can refuse it, so its length is what trying costs.
fn pattern(value: &str) -> String {
    let mut alternatives: Vec<String> = forms(value).iter().map(|form| spelled(form)).collect();
    // The value in another case: a server that upper-cases what it echoes
    // must not hand it back in the clear (attack on PR #631). Its letters as
    // classes of two and nothing else, since every escape in both cases would
    // make the matcher larger, and so the longest secret DFAI keeps shorter.
    if read_loosely(value) && value.chars().any(|c| c.is_ascii_alphabetic()) {
        alternatives.push(any_case(value));
    }
    alternatives.join("|")
}

/// `text` with each ASCII letter in either case, and nothing else escaped.
fn any_case(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_ascii_alphabetic() {
                format!("[{}{}]", c.to_ascii_lowercase(), c.to_ascii_uppercase())
            } else {
                regex::escape(&c.to_string())
            }
        })
        .collect()
}

/// The text a secret is sent as: as it is, and, when it is long enough to
/// tell from ordinary text, as base64 (standard and URL-safe, padded and not).
/// Each once, and longer forms first, so that where two match at the same
/// place the whole of the secret is struck.
fn forms(value: &str) -> Vec<String> {
    let mut forms = vec![value.to_string()];
    if value.chars().count() >= SHORTEST_FOR_BASE64 {
        forms.extend([STANDARD, URL_SAFE].map(|engine| engine.encode(value)));
        for engine in [STANDARD_NO_PAD, URL_SAFE_NO_PAD] {
            forms.push(engine.encode(value));
            forms.extend(base64_cores(&engine, value));
        }
    }
    forms.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    forms.dedup();
    forms
}

/// The base64 text the value always encodes to, wherever it sits in what was
/// encoded. Base64 writes each 3 bytes as 4 characters, so a value that starts
/// 0, 1 or 2 bytes into a group (`Bearer ` is 7 bytes) is written three
/// different ways; within each, the characters that hold a bit of a byte
/// before or after the value change with those bytes, and the rest do not.
/// Those are the core, and the padding is left outside it.
fn base64_cores(engine: &GeneralPurpose, value: &str) -> Vec<String> {
    const BITS_PER_CHAR: usize = 6;
    (0..3)
        .filter_map(|offset| {
            let mut placed = vec![0u8; offset];
            placed.extend_from_slice(value.as_bytes());
            let encoded = engine.encode(&placed);
            let first = (offset * 8).div_ceil(BITS_PER_CHAR);
            let end = (placed.len() * 8) / BITS_PER_CHAR;
            let core = encoded.get(first..end)?;
            (!core.is_empty()).then(|| core.to_string())
        })
        .collect()
}

/// A pattern for the text written in any mixture of its escaped forms. Any
/// character may be escaped, letters and digits too: `\u0067` is `g` to a JSON
/// parser and `%67` is `g` to a URL decoder.
fn spelled(text: &str) -> String {
    text.chars()
        .map(|c| format!("(?:{})", escapes_of(c).join("|")))
        .collect()
}

/// The ways one character is written: itself, percent-encoded once or twice in
/// either case, JSON-escaped, and a space form-encoded as `+`.
fn escapes_of(c: char) -> Vec<String> {
    let mut bytes = [0u8; 4];
    // `%25` is the `%` itself encoded again, as it is when a URL is put inside
    // another URL's query.
    let percent: String = c
        .encode_utf8(&mut bytes)
        .bytes()
        .map(|byte| format!("%(?:25)?{byte:02X}"))
        .collect();
    let mut forms = vec![regex::escape(&c.to_string()), format!("(?i:{percent})")];
    if c == ' ' {
        forms.push(regex::escape("+"));
    }
    if let Some(short) = json_short_escape(c) {
        forms.push(regex::escape(short));
    }
    // A character past the basic plane is a surrogate pair in JSON, which no
    // echo of a token has been seen to produce; the others are one `\u`.
    if let Ok(unit) = u16::try_from(u32::from(c)) {
        forms.push(format!("(?i:\\\\u{unit:04X})"));
    }
    forms
}

fn json_short_escape(c: char) -> Option<&'static str> {
    match c {
        '"' => Some("\\\""),
        '\\' => Some("\\\\"),
        '/' => Some("\\/"),
        '\n' => Some("\\n"),
        '\r' => Some("\\r"),
        '\t' => Some("\\t"),
        '\u{8}' => Some("\\b"),
        '\u{c}' => Some("\\f"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use regex::Regex;

    use super::{
        compiled, forms, matcher, matcher_with, pattern, Matchers, TooLongToProtect, HELD_AT_MOST,
        MATCHER_SIZE_LIMIT, NEVER_BUILDS_PAST,
    };

    /// Builds with `matcher`, counting each build.
    fn counted<'a>(
        builds: &'a Cell<usize>,
    ) -> impl FnOnce(&str) -> Result<Regex, TooLongToProtect> + 'a {
        move |value| {
            builds.set(builds.get() + 1);
            matcher(value)
        }
    }

    /// A matcher for the value as itself only: what is held, not how it is
    /// built, is what these tests are about.
    fn plain(value: &str) -> Result<Regex, TooLongToProtect> {
        Regex::new(&regex::escape(value)).map_err(|_| TooLongToProtect)
    }

    fn uses(matchers: &Matchers, values: impl IntoIterator<Item = String>) {
        for value in values {
            let _ = matchers.for_value(&value, plain);
        }
    }

    fn others(count: usize) -> impl Iterator<Item = String> {
        (0..count).map(|n| format!("grn_Other{n}"))
    }

    #[test]
    fn a_value_is_built_once_and_its_matcher_reused() {
        let (matchers, builds) = (Matchers::default(), Cell::new(0));

        let first = matchers
            .for_value("grn_FirstValue", counted(&builds))
            .unwrap();
        let again = matchers
            .for_value("grn_FirstValue", counted(&builds))
            .unwrap();

        assert_eq!(builds.get(), 1);
        assert_eq!(first.as_str(), again.as_str());
    }

    #[test]
    fn another_value_gets_its_own_matcher() {
        let (matchers, builds) = (Matchers::default(), Cell::new(0));
        matchers
            .for_value("grn_FirstValue", counted(&builds))
            .unwrap();

        let other = matchers
            .for_value("grn_OtherValue", counted(&builds))
            .unwrap();

        assert_eq!(builds.get(), 2);
        assert!(other.is_match("grn_OtherValue"));
        assert!(!other.is_match("grn_FirstValue"));
    }

    #[test]
    fn a_value_that_would_not_build_is_held_as_that_and_not_tried_again() {
        let (matchers, builds) = (Matchers::default(), Cell::new(0));
        let refused = |builds: &Cell<usize>| {
            builds.set(builds.get() + 1);
            Err(TooLongToProtect)
        };

        let first = matchers.for_value("grn_TooLong", |_| refused(&builds));
        let again = matchers.for_value("grn_TooLong", |_| refused(&builds));

        assert_eq!(
            (first.err(), again.err()),
            (Some(TooLongToProtect), Some(TooLongToProtect))
        );
        assert_eq!(builds.get(), 1, "the failed build was tried again");
    }

    #[test]
    fn no_more_than_eight_values_matchers_are_held() {
        let matchers = Matchers::default();

        uses(&matchers, others(3 * HELD_AT_MOST));

        assert_eq!(HELD_AT_MOST, 8);
        assert_eq!(matchers.len(), HELD_AT_MOST);
    }

    /// What a deleted secret, a forgotten key or a value refused at saving
    /// leaves behind: its matcher, until eight other values have been used.
    #[test]
    fn a_values_matcher_is_let_go_once_eight_other_values_are_used() {
        let matchers = Matchers::default();
        uses(&matchers, ["grn_DeletedLarkspurValue".to_string()]);

        uses(&matchers, others(HELD_AT_MOST - 1));
        assert!(matchers.holds("grn_DeletedLarkspurValue"), "let go early");

        uses(&matchers, others(HELD_AT_MOST).skip(HELD_AT_MOST - 1));
        assert!(!matchers.holds("grn_DeletedLarkspurValue"), "still held");
    }

    /// Least recently used, not first built: a value in use is not let go
    /// for being old.
    #[test]
    fn using_a_value_again_keeps_its_matcher_ahead_of_ones_used_since() {
        let (matchers, builds) = (Matchers::default(), Cell::new(0));
        let _ = matchers.for_value("grn_InUse", counted(&builds));
        uses(&matchers, others(HELD_AT_MOST - 1));

        let _ = matchers.for_value("grn_InUse", counted(&builds));
        uses(&matchers, others(HELD_AT_MOST).skip(HELD_AT_MOST - 1));

        assert_eq!(builds.get(), 1, "it was built again");
        assert!(matchers.holds("grn_InUse"), "the value in use was let go");
        assert!(!matchers.holds("grn_Other0"), "the oldest was kept");
    }

    #[test]
    fn values_that_would_not_build_count_toward_the_same_bound() {
        let matchers = Matchers::default();
        for value in others(HELD_AT_MOST) {
            let _ = matchers.for_value(&value, |_| Err(TooLongToProtect));
        }

        uses(&matchers, ["grn_Builds".to_string()]);

        assert_eq!(matchers.len(), HELD_AT_MOST);
        assert!(
            !matchers.holds("grn_Other0"),
            "a failure past the bound is held"
        );
        assert!(matchers.holds("grn_Builds"));
    }

    /// Two requests carrying a value not yet held build it at once; it is
    /// held once, not twice over the bound.
    #[test]
    fn a_value_built_twice_at_once_is_held_once() {
        let matchers = Matchers::default();

        let _ = matchers.for_value("grn_Twice", |value| {
            let _ = matchers.for_value(value, plain);
            plain(value)
        });

        assert_eq!(matchers.len(), 1);
    }

    /// Every value built in this run, by every test running at once, goes
    /// through the one cache, and it still never holds more than eight.
    #[test]
    fn the_matchers_held_in_this_run_are_never_more_than_eight() {
        for n in 0..2 * HELD_AT_MOST {
            super::ensure_strikable(&format!("grn_ThisRun{n}")).unwrap();
        }

        assert!(super::matchers().len() <= HELD_AT_MOST);
    }

    /// A secret with no `+`, `/` or `?` in its base64 reads the same in both
    /// alphabets, so most of its forms come twice; each is looked for once.
    #[test]
    fn each_form_is_looked_for_once_and_the_longest_first() {
        let made = forms("grn_Larkspur");

        let mut unique = made.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), made.len(), "{made:?}");
        assert!(
            made.windows(2).all(|pair| pair[0].len() >= pair[1].len()),
            "{made:?}"
        );
    }

    /// The size limit is what bounds a build: a signed token of some 3 KB
    /// fits within it, and one four times as long is refused by it rather
    /// than built at whatever cost.
    #[test]
    fn building_a_matcher_is_bounded_by_the_size_limit() {
        let token = super::super::tests::a_signed_token(3_000);

        matcher(&token).expect("a 3 KB signed token fits the limit");
        match compiled(&token.repeat(4)) {
            Err(regex::Error::CompiledTooBig(limit)) => assert_eq!(limit, MATCHER_SIZE_LIMIT),
            other => panic!(
                "a secret four times as long was built: {:?}",
                other.map(|_| ())
            ),
        }
    }

    /// A value of megabytes would be a pattern of gigabytes before the size
    /// limit is ever reached, so it is refused before one is written. The
    /// ceiling refuses nothing that would build — a value as long as the
    /// ceiling, of the character cheapest per byte, already does not — and
    /// sits close enough to what does that one much past it is not tried.
    const LONGEST_SEEN_TO_BUILD: usize = 5_010;

    /// Whether `matcher_with` tried to build `value`'s matcher at all.
    fn tried_to_build(value: &str) -> (Result<(), TooLongToProtect>, bool) {
        let tried = Cell::new(false);
        let refused = matcher_with(value, |value| {
            tried.set(true);
            compiled(value)
        });
        (refused.map(|_| ()), tried.get())
    }

    #[test]
    fn a_value_past_what_could_ever_build_is_refused_without_building() {
        let huge = "k".repeat(256 * 1024);
        assert_eq!(tried_to_build(&huge), (Err(TooLongToProtect), false));

        let at_the_ceiling = "€".repeat(NEVER_BUILDS_PAST / '€'.len_utf8());
        assert!(compiled(&at_the_ceiling).is_err(), "the ceiling builds");

        // Half as long again as the longest value seen to build (5,010 bytes
        // of `€`) is refused at once, not after seconds of trying.
        let half_again = "~".repeat(LONGEST_SEEN_TO_BUILD * 3 / 2);
        assert_eq!(tried_to_build(&half_again), (Err(TooLongToProtect), false));
    }

    /// Adversarial (P28-10 round 3, after 0d51773). A value under the ceiling
    /// that will not build is refused only after its whole pattern is written
    /// and parsed: with the ceiling at 16 KiB that was 5.8 s in a debug build
    /// (1.3 s in release) for printable ASCII. Round 4 lowered the ceiling to
    /// 6 KiB, near the 4.3 KB that builds; the costliest value it still lets
    /// through, 6,143 bytes of `~`, measured 1.9 s alone in a debug build and
    /// 0.31 s in release, and it is checked off the async worker in any case.
    ///
    /// Measured by the pattern each writes, against the longest value that
    /// is kept, rather than by a clock: what trying costs is writing and
    /// parsing its pattern, and a pattern's length is the same on every
    /// machine, where under a loaded gate the timed refusal took 8.9 s (#385).
    #[test]
    fn a_value_too_long_to_protect_is_refused_without_seconds_of_building() {
        let longest_kept = "€".repeat(LONGEST_SEEN_TO_BUILD / '€'.len_utf8());
        matcher(&longest_kept).expect("the longest value seen to build builds");
        let pasted = "~".repeat(NEVER_BUILDS_PAST - 1);
        assert_eq!(matcher(&pasted).err(), Some(TooLongToProtect));

        let refusing = pattern(&pasted).len();
        let building = pattern(&longest_kept).len();
        assert!(
            refusing < building * 6,
            "refusing it writes {refusing} bytes of pattern; building the longest value kept, {building}"
        );
    }

    /// Checking a value builds its matcher, most of a second for one of some
    /// kilobytes in a debug build, on a thread kept for it.
    #[tokio::test]
    async fn checking_a_value_off_the_worker_never_stalls_it() {
        let value = format!(
            "grn_CheckedOffWorker{}",
            super::super::tests::a_signed_token(2_000)
        );

        let checked = super::super::tests::assert_never_stalls_the_worker(
            super::ensure_strikable_off_worker(value),
        )
        .await;

        assert_eq!(checked, Ok(()));
        let too_long = "k".repeat(NEVER_BUILDS_PAST + 1);
        assert_eq!(
            super::ensure_strikable_off_worker(too_long).await,
            Err(TooLongToProtect)
        );
    }

    /// Fails closed: work that cannot finish on the blocking thread answers
    /// the refusal it was given, not a value nobody checked.
    #[tokio::test]
    async fn work_that_cannot_finish_off_the_worker_answers_the_refusal() {
        let answered = super::on_blocking_thread(
            || -> Result<(), &str> { panic!("the build could not finish") },
            Err("refused"),
        )
        .await;

        assert_eq!(answered, Err("refused"));
    }

    /// The decoding layer, end to end (review of PR #631's redaction).
    mod decoding {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;
        use regex::RegexBuilder;

        use super::super::{compiled, forms, redact, spelled, DECODES, SCANNED_BYTES};
        use crate::secrets::tests::a_signed_token;

        const LONG: &str = "Fict10nal-Larkspur_Secret.42";

        fn used(value: &str) -> Vec<(String, String)> {
            vec![("k".to_string(), value.to_string())]
        }

        fn struck(text: &str, value: &str) -> String {
            redact(text, &used(value))
        }

        /// A seeded generator: the same seed, the same bytes.
        fn seeded_bytes(len: usize, mut seed: u64) -> Vec<u8> {
            (0..len)
                .map(|_| {
                    seed = seed
                        .wrapping_mul(6_364_136_223_846_793_005)
                        .wrapping_add(1_442_695_040_888_963_407);
                    (seed >> 56) as u8
                })
                .collect()
        }

        fn wrapped(text: &str, width: usize, line_break: &str) -> String {
            text.as_bytes()
                .chunks(width)
                .map(|line| std::str::from_utf8(line).unwrap())
                .collect::<Vec<_>>()
                .join(line_break)
        }

        #[test]
        fn a_secret_written_with_html_entities_named_or_numeric_is_struck() {
            let value = r#"ab"cd&ef<gh>9xyz12"#;
            for form in [
                "ab&quot;cd&amp;ef&lt;gh&gt;9xyz12".to_string(),
                "ab&#34;cd&#x26;ef&#60;gh&#x3e;9xy&#122;12".to_string(),
                "ab&#x0000022;cd&#38ef&lt;gh&gt;9xyz12".to_string(),
            ] {
                let out = struck(&format!("<p>{form}</p>"), value);
                assert_eq!(out, "<p>[secret k removed]</p>", "{form}");
            }
        }

        #[test]
        fn a_secret_with_a_space_or_quote_and_one_entity_is_struck() {
            let value = "pass wor9xyz'12";
            let out = struck("said: pass wor9xy&#122;&apos;12 then", value);
            assert_eq!(out, "said: [secret k removed] then");
        }

        #[test]
        fn base64_of_a_secret_wrapped_any_way_is_struck() {
            let encoded = STANDARD.encode(format!("Bearer {LONG}"));
            for line_break in ["\n", "\r\n", "\r", "\\n", "\\r\\n", "&#10;", "\n    "] {
                let form = wrapped(&encoded, 6, line_break);
                let out = struck(&format!("x {form} y"), LONG);
                assert!(!out.contains(&form), "{line_break:?}: {out}");
                assert!(
                    out.starts_with("x ") && out.ends_with(" y"),
                    "{line_break:?}: {out}"
                );
            }
        }

        #[test]
        fn only_the_secret_is_struck_from_a_field_of_many_lines() {
            let mut lines: Vec<String> = (0..2_000).map(|at| format!("id-{at:05}")).collect();
            lines.push(LONG.to_string());
            let field = lines.join("\\n");
            let out = struck(&format!(r#"{{"log":"{field}"}}"#), LONG);
            let kept = lines[..2_000].join("\\n");
            assert_eq!(out, format!(r#"{{"log":"{kept}\n[secret k removed]"}}"#));
        }

        #[test]
        fn an_answer_with_no_secret_in_it_comes_back_byte_for_byte() {
            let image = wrapped(&STANDARD.encode(seeded_bytes(750_000, 7)), 76, "\r\n");
            let json_image = wrapped(&STANDARD.encode(seeded_bytes(750_000, 8)), 76, "\\n");
            let lines: Vec<String> = (0..2_000)
                .map(|at| format!("line {at} &amp; more"))
                .collect();
            for body in [image, json_image, lines.join("\\n")] {
                assert_eq!(struck(&body, LONG), body);
            }
        }

        #[test]
        fn a_short_secret_is_found_only_as_it_is_and_in_the_forms_it_always_was() {
            assert_eq!(struck("KEY1 and key1", "Key1"), "KEY1 and key1");
            assert_eq!(struck("abc\ndef ghi", "abcdef"), "abc\ndef ghi");
            assert_eq!(struck("ab&#99;def", "abcdef"), "ab&#99;def");
            // Beside a long secret, which has the answer decoded, a short one is still not read loosely.
            let both = vec![
                ("short".to_string(), "abcdef".to_string()),
                ("long".to_string(), LONG.to_string()),
            ];
            assert_eq!(
                redact("ab&#99;def and abc\ndef", &both),
                "ab&#99;def and abc\ndef"
            );
            assert_eq!(
                struck("x Key1 %4B%65y1 y", "Key1"),
                "x [secret k removed] [secret k removed] y"
            );
        }

        /// Short named secrets against seeded base64 blobs, as JSON escapes
        /// them: a chance hit strikes a few bytes, never a run.
        #[test]
        fn a_short_secret_strikes_seeded_blobs_rarely_and_only_where_it_is() {
            let alphabet: Vec<char> = ('a'..='z').collect();
            let blob = wrapped(&STANDARD.encode(seeded_bytes(150_000, 3)), 76, "\\n");
            let mut touched = 0;
            for seed in 0..40u64 {
                let value: String = seeded_bytes(4, seed + 100)
                    .iter()
                    .map(|byte| alphabet[*byte as usize % alphabet.len()])
                    .collect();
                let out = struck(&blob, &value);
                if out != blob {
                    touched += 1;
                    let removed = blob.len() as isize - out.len() as isize;
                    let marks = out.matches("[secret k removed]").count() as isize;
                    // Each strike takes the secret's own few bytes, not a line or a run.
                    assert!(
                        removed + marks * 18 <= marks * 4 * 3,
                        "{value}: {removed} bytes for {marks}"
                    );
                }
            }
            assert!(
                touched <= 6,
                "{touched} of 40 short secrets touched the blob"
            );
        }

        /// Every secret that built under the old limit, with the old matcher,
        /// still builds now: none kept before is refused.
        #[test]
        fn every_secret_length_that_built_before_still_builds() {
            let old = |value: &str| {
                let pattern: Vec<String> = forms(value).iter().map(|form| spelled(form)).collect();
                RegexBuilder::new(&pattern.join("|"))
                    .size_limit(12 * 1024 * 1024)
                    .build()
                    .is_ok()
            };
            let printable: String = (' '..='~').cycle().take(4_000).collect();
            let mut values: Vec<String> =
                (2_500..=3_400).step_by(100).map(a_signed_token).collect();
            values.extend(
                (2_300..=2_700)
                    .step_by(80)
                    .map(|len| printable[..len].to_string()),
            );
            values.extend((4_000..=5_100).step_by(366).map(|len| "€".repeat(len / 3)));
            for value in values {
                if old(&value) {
                    assert!(
                        compiled(&value).is_ok(),
                        "{} bytes built before",
                        value.len()
                    );
                }
            }
        }

        /// Review of PR #631, round 2: a secret whose own text holds a line
        /// break or a backslash escape, echoed with an entity, is struck.
        #[test]
        fn a_secret_holding_a_break_or_an_escape_echoed_with_an_entity_is_struck() {
            for (value, echo) in [
                (
                    "-----BEGIN-----\nMIIEabc\n-----END-----",
                    "-----BEGIN-----&#10;MIIEabc&#10;-----END-----",
                ),
                ("user1\npass2word", "user1&#10;pass2word"),
                (r"C:\temp\fileKey9", r"C:\temp\fil&#101;Key9"),
                (r"\bC4NxzRFYF\BKc2L", r"\bC4Nx&#122;RFYF\BKc2L"),
                (r"GHQHD8\nBzU4tK", r"GHQHD&#x38\nBzU4tK"),
            ] {
                let out = struck(&format!("<{echo}>"), value);
                assert_eq!(out, "<[secret k removed]>", "{value:?} echoed as {echo:?}");
            }
        }

        /// The reviewer's seeded fuzz: 5,000 secrets of 8 to 19 characters,
        /// each written with entities or with JSON escapes at random places,
        /// between sentinels. Every one is struck, and no sentinel is touched.
        #[test]
        fn a_seeded_fuzz_of_entity_and_json_echoes_leaks_nothing() {
            let alphabet: Vec<char> = ('A'..='Z')
                .chain('a'..='z')
                .chain('0'..='9')
                .chain(['€', 'é', '&', '<', '"', ' ', '\\', '\n', '😀'])
                .collect();
            let mut seed = 5u64;
            let mut next = move || {
                seed = seed
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                (seed >> 33) as usize
            };
            let mut leaked = Vec::new();
            for case in 0..5_000 {
                let len = 8 + next() % 12;
                let value: String = (0..len)
                    .map(|_| alphabet[next() % alphabet.len()])
                    .collect();
                let chars: Vec<char> = value.chars().collect();
                let html = next() % 2 == 0;
                let mut echo = String::new();
                for (at, &c) in chars.iter().enumerate() {
                    let before_alnum = chars.get(at + 1).is_some_and(|n| n.is_ascii_alphanumeric());
                    let pick = next() % 4;
                    echo += &if html {
                        match (pick, c) {
                            (0, _) => format!("&#{};", c as u32),
                            (1, _) if !before_alnum => format!("&#x{:X}", c as u32),
                            (2, '<') => "&lt;".into(),
                            (2, '"') => "&quot;".into(),
                            (_, '&') => "&amp;".into(),
                            _ => c.to_string(),
                        }
                    } else {
                        match (pick, c) {
                            (_, '\\') => "\\\\".into(),
                            (_, '"') => "\\\"".into(),
                            (_, '\n') => "\\n".into(),
                            (0, _) if (c as u32) < 0x10000 => format!("\\u{:04x}", c as u32),
                            (1, '😀') => "\\ud83d\\ude00".into(),
                            _ => c.to_string(),
                        }
                    };
                }
                let body = format!("«L{case}» {echo} «R{case}»");
                let out = struck(&body, &value);
                let kept = out.starts_with(&format!("«L{case}» "))
                    && out.ends_with(&format!(" «R{case}»"));
                if !out.contains("[secret k removed]") || !kept {
                    leaked.push((value, body, out));
                }
            }
            assert!(
                leaked.is_empty(),
                "{} of 5,000: {:?}",
                leaked.len(),
                &leaked[..leaked.len().min(3)]
            );
        }

        /// Every reading is decoded at most once for a call, however many
        /// secrets: for an answer holding entities, escapes and breaks, at most
        /// one decode for each of the seven readings, and each secret reads the
        /// answer and each reading once.
        #[test]
        fn each_reading_is_decoded_once_a_call() {
            let secrets: Vec<(String, String)> = (0..8)
                .map(|at| (format!("s{at}"), format!("{LONG}{at}")))
                .collect();
            let body = "a&#65;b\\u0041c\nQUJD\r\nREVG ".repeat(20_000);
            let decodes = DECODES.with(|count| count.get());
            let scanned = SCANNED_BYTES.with(|count| count.get());
            let _ = redact(&body, &secrets);
            assert!(DECODES.with(|count| count.get()) - decodes <= 7);
            let read = SCANNED_BYTES.with(|count| count.get()) - scanned;
            assert!(
                read <= 8 * 8 * body.len(),
                "{read} bytes read for {}",
                body.len()
            );
        }

        /// What eight secrets cost against hostile bodies, counted rather than
        /// timed: the answer is decoded once, and each secret's matcher reads
        /// at most the answer and what was decoded from it — within twice the
        /// one read each had before.
        #[test]
        fn eight_secrets_read_a_hostile_answer_at_most_twice_each() {
            let secrets: Vec<(String, String)> = (0..8)
                .map(|at| (format!("s{at}"), format!("{LONG}{at}")))
                .collect();
            for body in [
                "&#65;".repeat(40_000),
                "&#1; ".repeat(40_000),
                "a\nb ".repeat(50_000),
                "a\\nb ".repeat(40_000),
                format!("{}\n", &LONG[..20]).repeat(8_000),
            ] {
                let decodes = DECODES.with(|count| count.get());
                let scanned = SCANNED_BYTES.with(|count| count.get());
                let _ = redact(&body, &secrets);
                assert_eq!(DECODES.with(|count| count.get()) - decodes, 1);
                let read = SCANNED_BYTES.with(|count| count.get()) - scanned;
                assert!(
                    read <= 8 * 2 * body.len(),
                    "{read} bytes read for {}",
                    body.len()
                );
            }
        }
    }
}
