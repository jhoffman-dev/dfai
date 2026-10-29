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
//! the three alignments it can sit at. The value itself is found in either
//! case. Two forms are found by reading the answer rather than by a longer
//! matcher, which would cap how long a secret may be (attack on PR #631): a
//! run of text holding HTML numeric entities is read with them decoded, and a
//! run of base64 wrapped into lines (CRLF or LF, as itself or JSON-escaped,
//! wherever it falls) is read with the breaks taken out; either run is struck
//! whole when the secret is in it.
//!
//! What is deliberately not looked for, and why that is acceptable:
//!
//! - hex, `\x` and `\u{…}` escapes, an NFD-normalised copy, base64 of the
//!   percent-encoded value, and an echo cut short.
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

/// Handed back in place of a response that could not be checked. Nothing is
/// better than something that might hold a secret.
const UNCHECKED: &str = "[the response could not be checked for secrets, so it is not shown]";

/// What one secret's matcher may take, which bounds what building it costs
/// and so how long a secret DFAI keeps may be: a value whose matcher will
/// not build within it is refused when it is saved, and never sent. Every
/// character may be written several ways, so what fits depends on which
/// characters they are — some 2.2 KB of printable ASCII in no order, and a
/// signed token's letters, digits, `-`, `_` and `.` up to some 2.7 KB. Past
/// that a token fits or not by its length (how its base64 forms align): one
/// of 3,000 bytes builds and one of 2,900 does not.
/// Raised from 12 MiB when the value in another case was added to every
/// matcher (attack on PR #631), so that no secret kept before is refused now.
const MATCHER_SIZE_LIMIT: usize = 14 * 1024 * 1024;

/// A value longer than this is refused without trying to build its matcher.
/// Building one writes and parses the whole pattern before the size limit is
/// reached, which takes seconds for a value of a few times this; and no value
/// of more than some 4.3 KB (of `€`, the cheapest character per byte) has
/// been seen to fit `MATCHER_SIZE_LIMIT`, so this refuses nothing that would
/// build.
const NEVER_BUILDS_PAST: usize = 6 * 1024;

/// How many values' matchers are held at once.
const HELD_AT_MOST: usize = 8;

/// A secret whose matcher would not build within `MATCHER_SIZE_LIMIT`: it
/// could not be struck from what comes back, so it is neither kept nor sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TooLongToProtect;

/// A secret shorter than this is not looked for as base64: the base64 of one
/// or two bytes is a character or two, which ordinary text is full of.
const SHORTEST_FOR_BASE64: usize = 8;

/// Replaces every secret that went into a request wherever it appears in what
/// came back, in any of the forms described above.
pub fn redact(text: &str, used: &[(String, String)]) -> String {
    let mut found: Vec<(usize, usize, &str)> = Vec::new();
    for (name, value) in used.iter().filter(|(_, value)| !value.is_empty()) {
        let Ok(matcher) = matchers().for_value(value, matcher) else {
            return UNCHECKED.to_string();
        };
        found.extend(
            matcher
                .find_iter(text)
                .map(|at| (at.start(), at.end(), name.as_str())),
        );
        found.extend(
            runs_read_otherwise(text)
                .filter(|(_, _, read)| matcher.is_match(read))
                .map(|(start, end, _)| (start, end, name.as_str())),
        );
    }
    strike(text, found)
}

/// One HTML numeric entity, decimal or hex.
const ENTITY: &str = r"&#(?:[xX][0-9a-fA-F]{1,6}|[0-9]{1,7});";

/// A run of text holding at least one HTML numeric entity: no white space,
/// quote or angle bracket, which end a value in JSON or HTML.
fn entity_runs() -> &'static Regex {
    static RUNS: OnceLock<Regex> = OnceLock::new();
    RUNS.get_or_init(|| {
        let piece = format!(r#"(?:[^\s"'<>&]|{ENTITY})"#);
        Regex::new(&format!("{piece}*{ENTITY}{piece}*")).expect("the entity-run pattern compiles")
    })
}

fn one_entity() -> &'static Regex {
    static ONE: OnceLock<Regex> = OnceLock::new();
    ONE.get_or_init(|| {
        Regex::new(r"&#(?:[xX]([0-9a-fA-F]{1,6})|([0-9]{1,7}));")
            .expect("the entity pattern compiles")
    })
}

/// A line break a base64 encoder wraps at: CRLF or LF, as itself or JSON-escaped.
const LINE_BREAK: &str = r"\r?\n|\\r\\n|\\n";

/// A run of base64 broken into lines, wherever the breaks fall.
fn wrapped_runs() -> &'static Regex {
    static RUNS: OnceLock<Regex> = OnceLock::new();
    RUNS.get_or_init(|| {
        Regex::new(&format!(
            r"[A-Za-z0-9+/=_-]+(?:(?:{LINE_BREAK})[A-Za-z0-9+/=_-]+)+"
        ))
        .expect("the wrapped-run pattern compiles")
    })
}

fn line_breaks() -> &'static Regex {
    static BREAKS: OnceLock<Regex> = OnceLock::new();
    BREAKS.get_or_init(|| Regex::new(LINE_BREAK).expect("the line-break pattern compiles"))
}

/// The character an entity names, or nothing for one that names none.
fn entity_char(entity: &regex::Captures) -> String {
    let code = match (entity.get(1), entity.get(2)) {
        (Some(hex), _) => u32::from_str_radix(hex.as_str(), 16).ok(),
        (_, Some(decimal)) => decimal.as_str().parse().ok(),
        _ => None,
    };
    code.and_then(char::from_u32)
        .map(String::from)
        .unwrap_or_default()
}

/// Each run's span in `text`, and the run read with its entities decoded or
/// its line breaks taken out.
fn runs_read_otherwise(text: &str) -> impl Iterator<Item = (usize, usize, String)> + '_ {
    let decoded = entity_runs().find_iter(text).map(|run| {
        let read = one_entity().replace_all(run.as_str(), entity_char);
        (run.start(), run.end(), read.into_owned())
    });
    let joined = wrapped_runs().find_iter(text).map(|run| {
        let read = line_breaks().replace_all(run.as_str(), "");
        (run.start(), run.end(), read.into_owned())
    });
    decoded.chain(joined)
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
    if value.chars().any(|c| c.is_ascii_alphabetic()) {
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
    const LONGEST_SEEN_TO_BUILD: usize = 4_293;

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

        // Half as long again as the longest value seen to build (4,293 bytes
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
}
