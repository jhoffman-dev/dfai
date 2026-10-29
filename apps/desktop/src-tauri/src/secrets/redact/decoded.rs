//! An answer read the way a reader of it would: entities and JSON escapes
//! decoded, and base64 that was wrapped into lines joined up, with a map from
//! every position in what was read back to the text it came from.
//!
//! Read in one pass, once per answer, however many secrets are looked for in
//! it. Text that needs no decoding is copied as it is and mapped by offset,
//! so the map holds one entry per decoded piece, not per byte.

/// One stretch of what was read and the stretch of the original it came
/// from: copied as it is (`copied`), or one decoded character, or a line
/// break taken out of wrapped base64 (nothing read, `read_len` 0).
#[derive(Debug, Clone, Copy)]
struct Segment {
    read_start: usize,
    read_len: usize,
    original_start: usize,
    original_len: usize,
    copied: bool,
}

/// Which readings a text gets: HTML entities decoded, JSON escapes decoded,
/// wrapped base64 joined. Each is a reading of its own, alone or with the
/// others, so one layer's change to a secret's own text cannot hide it from
/// another's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Layers {
    pub entities: bool,
    pub json: bool,
    pub join: bool,
}

impl Layers {
    pub const ALL: Layers = Layers {
        entities: true,
        json: true,
        join: true,
    };
}

/// The text as read, and where each piece of it came from.
pub struct Decoded {
    text: String,
    segments: Vec<Segment>,
}

/// What base64 is written in, both alphabets and padding: the characters a
/// wrapped line break may sit between.
fn is_base64(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '-' | '_')
}

/// A byte that starts an entity, an escape or a line break: every other byte
/// is copied as it is. All are ASCII, so a stretch between them is whole
/// characters.
fn starts_a_piece(byte: u8) -> bool {
    matches!(byte, b'&' | b'\\' | b'\n' | b'\r')
}

/// The five named entities an HTML escaper writes.
const NAMED: [(&str, char); 5] = [
    ("&amp;", '&'),
    ("&lt;", '<'),
    ("&gt;", '>'),
    ("&quot;", '"'),
    ("&apos;", '\''),
];

/// The value of a run of digits in `radix`, or None past what a character can be.
fn digits_value(digits: &str, radix: u32) -> Option<u32> {
    digits.chars().try_fold(0u32, |value, digit| {
        let value = value
            .checked_mul(radix)?
            .checked_add(digit.to_digit(radix)?)?;
        (value <= 0x10_FFFF).then_some(value)
    })
}

/// A numeric entity at the start of `rest` — `&#65;`, `&#x41;`, any number of
/// digits, the `;` optional — as the character it names and its length. A
/// surrogate, zero or a value past Unicode names none, and is left as written.
fn numeric_entity(rest: &str) -> Option<(char, usize)> {
    let after = rest.strip_prefix("&#")?;
    let (radix, digits_from) = match after.as_bytes().first() {
        Some(b'x' | b'X') => (16, 3),
        _ => (10, 2),
    };
    let digits_len = rest[digits_from..]
        .bytes()
        .take_while(|byte| (*byte as char).is_digit(radix))
        .count();
    if digits_len == 0 {
        return None;
    }
    let digits = &rest[digits_from..digits_from + digits_len];
    let code = digits_value(digits, radix).filter(|code| *code != 0)?;
    let mut len = digits_from + digits_len;
    if rest[len..].starts_with(';') {
        len += 1;
    }
    Some((char::from_u32(code)?, len))
}

fn entity(rest: &str) -> Option<(char, usize)> {
    NAMED
        .iter()
        .find(|(name, _)| rest.starts_with(name))
        .map(|(name, c)| (*c, name.len()))
        .or_else(|| numeric_entity(rest))
}

/// Four hex digits after `\u` at the start of `rest`, as a UTF-16 unit.
fn unit(rest: &str) -> Option<u16> {
    let hex = rest.strip_prefix("\\u")?.get(..4)?;
    if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    u16::from_str_radix(hex, 16).ok()
}

/// A JSON escape at the start of `rest`, as the character it writes and its
/// length. A surrogate pair is one character; half of one is left as written.
fn json_escape(rest: &str) -> Option<(char, usize)> {
    let short = match rest.as_bytes().get(..2)? {
        b"\\n" => Some('\n'),
        b"\\r" => Some('\r'),
        b"\\t" => Some('\t'),
        b"\\\"" => Some('"'),
        b"\\\\" => Some('\\'),
        b"\\/" => Some('/'),
        b"\\b" => Some('\u{8}'),
        b"\\f" => Some('\u{c}'),
        _ => None,
    };
    if let Some(c) = short {
        return Some((c, 2));
    }
    let high = unit(rest)?;
    if let Some(c) = char::from_u32(u32::from(high)) {
        return Some((c, 6));
    }
    let low = unit(&rest[6..]).filter(|low| (0xDC00..0xE000).contains(low))?;
    // A low surrogate first, or a high one twice, decodes to an error: left as written.
    let pair = char::decode_utf16([high, low]).next()?.ok()?;
    Some((pair, 12))
}

/// The ways one line break is written, longest first: as itself, JSON-escaped,
/// or as entities.
const LINE_BREAKS: [&str; 15] = [
    "&#13;&#10;",
    "&#xD;&#xA;",
    "&#xd;&#xa;",
    "\\r\\n",
    "&#10;",
    "&#13;",
    "&#xA;",
    "&#xa;",
    "&#xD;",
    "&#xd;",
    "\r\n",
    "\\n",
    "\\r",
    "\n",
    "\r",
];

/// The length of the line break at the start of `rest`, with the indent that
/// follows it, when what follows is more base64: a wrap, not a paragraph.
fn wrap_at(rest: &str) -> Option<usize> {
    let line_break = LINE_BREAKS
        .iter()
        .find(|written| rest.starts_with(*written))?;
    let after = &rest[line_break.len()..];
    let indent = after
        .bytes()
        .take_while(|byte| matches!(byte, b' ' | b'\t'))
        .count();
    let next = after[indent..].chars().next()?;
    is_base64(next).then_some(line_break.len() + indent)
}

impl Decoded {
    /// `text` read with its entities and escapes decoded and its wrapped lines
    /// joined, or None when nothing in it reads otherwise.
    pub fn of(text: &str, _layers: Layers) -> Option<Decoded> {
        if !text.bytes().any(starts_a_piece) {
            return None;
        }
        let mut read = Reading::default();
        let mut at = 0;
        while let Some(c) = text[at..].chars().next() {
            let rest = &text[at..];
            if !starts_a_piece(rest.as_bytes()[0]) {
                // Copied a stretch at a time: only these bytes start anything read otherwise.
                let plain = rest.bytes().position(starts_a_piece).unwrap_or(rest.len());
                read.copied(&rest[..plain], at);
                at += plain;
                continue;
            }
            let wraps = read.text.chars().last().is_some_and(is_base64);
            if let Some(len) = wraps.then(|| wrap_at(rest)).flatten() {
                read.decoded(None, at, len);
                at += len;
            } else if let Some((c, len)) = (c == '&').then(|| entity(rest)).flatten() {
                read.decoded(Some(c), at, len);
                at += len;
            } else if let Some((c, len)) = (c == '\\').then(|| json_escape(rest)).flatten() {
                read.decoded(Some(c), at, len);
                at += len;
            } else {
                read.copied(&rest[..c.len_utf8()], at);
                at += c.len_utf8();
            }
        }
        read.decoded_any.then_some(Decoded {
            text: read.text,
            segments: read.segments,
        })
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    /// What this reading holds on to: its text and its map.
    pub fn retained_bytes(&self) -> usize {
        self.text.capacity() + self.segments.capacity() * std::mem::size_of::<Segment>()
    }

    /// The segment that read position `at` lies in.
    fn segment_holding(&self, at: usize) -> &Segment {
        let after = self
            .segments
            .partition_point(|segment| segment.read_start + segment.read_len <= at);
        &self.segments[after.min(self.segments.len() - 1)]
    }

    /// The span of the original text that `start..end` of what was read came
    /// from, widened to whole entities and escapes. `start < end`, both on
    /// character boundaries of what was read.
    pub fn original_span(&self, start: usize, end: usize) -> (usize, usize) {
        let first = self.segment_holding(start);
        let from = if first.copied {
            first.original_start + (start - first.read_start)
        } else {
            first.original_start
        };
        let last = self.segment_holding(end - 1);
        let to = if last.copied {
            last.original_start + (end - last.read_start)
        } else {
            last.original_start + last.original_len
        };
        (from, to)
    }
}

/// What has been read so far.
#[derive(Default)]
struct Reading {
    text: String,
    segments: Vec<Segment>,
    decoded_any: bool,
}

impl Reading {
    /// Text copied as it is, joined to the copied stretch before it.
    fn copied(&mut self, piece: &str, original_at: usize) {
        let len = piece.len();
        let read_start = self.text.len();
        self.text.push_str(piece);
        if let Some(last) = self.segments.last_mut() {
            let follows = last.original_start + last.original_len == original_at;
            if last.copied && follows {
                last.read_len += len;
                last.original_len += len;
                return;
            }
        }
        self.segments.push(Segment {
            read_start,
            read_len: len,
            original_start: original_at,
            original_len: len,
            copied: true,
        });
    }

    /// `original_len` bytes at `original_at` read as `c`, or as nothing.
    fn decoded(&mut self, c: Option<char>, original_at: usize, original_len: usize) {
        let read_start = self.text.len();
        if let Some(c) = c {
            self.text.push(c);
        }
        self.decoded_any = true;
        self.segments.push(Segment {
            read_start,
            read_len: c.map_or(0, char::len_utf8),
            original_start: original_at,
            original_len,
            copied: false,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{Decoded, Layers};

    const ENTITIES: Layers = Layers {
        entities: true,
        json: false,
        join: false,
    };
    const JSON: Layers = Layers {
        entities: false,
        json: true,
        join: false,
    };
    const JOIN: Layers = Layers {
        entities: false,
        json: false,
        join: true,
    };

    fn read_as(text: &str, layers: Layers) -> Option<String> {
        Decoded::of(text, layers).map(|decoded| decoded.text().to_string())
    }

    #[test]
    fn each_layer_reads_only_its_own_pieces() {
        let text = r"a\tb&#99;d";
        assert_eq!(read_as(text, ENTITIES).as_deref(), Some(r"a\tbcd"));
        assert_eq!(read_as(text, JSON).as_deref(), Some("a\tb&#99;d"));
        assert_eq!(read_as(text, JOIN), None);
    }

    #[test]
    fn an_entity_line_break_is_itself_unless_joining_and_joined_only_with_entities() {
        assert_eq!(
            read_as("user1&#10;pass2", ENTITIES).as_deref(),
            Some("user1\npass2")
        );
        assert_eq!(read_as("QUJD&#10;REVG", JOIN), None);
        let both = Layers {
            entities: true,
            json: false,
            join: true,
        };
        assert_eq!(read_as("QUJD&#10;REVG", both).as_deref(), Some("QUJDREVG"));
        assert_eq!(read_as(r"QUJD\nREVG", both), None);
        assert_eq!(read_as(r"QUJD\nREVG", JOIN), None);
        assert_eq!(read_as("QUJD\nREVG", JOIN).as_deref(), Some("QUJDREVG"));
    }

    #[test]
    fn a_layer_whose_pieces_are_not_in_the_text_is_not_read() {
        assert_eq!(
            read_as(
                "plain QUJD
REVG",
                ENTITIES
            ),
            None
        );
        assert_eq!(read_as("a &amp; b", JSON), None);
    }

    /// Review of PR #631, round 2: 145 MB held for an 8 MB answer of entities.
    #[test]
    fn a_reading_of_an_answer_dense_with_entities_holds_a_few_times_its_size() {
        let text = "&#1; ".repeat(400_000);
        let decoded = Decoded::of(&text, ENTITIES).unwrap();
        assert!(
            decoded.retained_bytes() <= 4 * text.len(),
            "{} bytes held for {}",
            decoded.retained_bytes(),
            text.len()
        );
    }

    fn read(text: &str) -> String {
        Decoded::of(text, Layers::ALL)
            .map(|decoded| decoded.text().to_string())
            .unwrap_or_else(|| text.to_string())
    }

    #[test]
    fn text_with_nothing_to_decode_is_not_read_again() {
        for text in ["plain words", "a&b c", "50% off", "no breaks here"] {
            assert!(Decoded::of(text, Layers::ALL).is_none(), "{text:?}");
        }
    }

    #[test]
    fn numeric_entities_decode_in_any_digit_count_with_or_without_a_semicolon() {
        for text in [
            "&#65;",
            "&#x41;",
            "&#X41;",
            "&#0000000065;",
            "&#x00000041;",
            "&#65",
            "&#x41 ",
        ] {
            assert!(
                read(text).starts_with('A'),
                "{text:?} read as {:?}",
                read(text)
            );
        }
    }

    #[test]
    fn the_five_named_entities_decode() {
        assert_eq!(
            read("&amp;&lt;&gt;&quot;&apos;&#39;"),
            "&<>\"''".to_string()
        );
    }

    #[test]
    fn a_malformed_or_impossible_entity_stays_as_it_is() {
        for text in [
            "&#;",
            "&#x;",
            "&#xD800;",
            "&#xDFFF;",
            "&#x110000;",
            "&#99999999999;",
            "&#x0;",
            "&#0;",
            "&bogus;",
            "&amp",
        ] {
            assert_eq!(read(text), text, "{text:?}");
        }
    }

    #[test]
    fn json_escapes_decode_and_a_surrogate_pair_is_one_character() {
        assert_eq!(read(r"Aé"), "Aé");
        assert_eq!(read(r"😀"), "😀");
        assert_eq!(read(r#"a\"b\\c\/d"#), r#"a"b\c/d"#);
        assert_eq!(read(r"x\ty"), "x\ty");
    }

    #[test]
    fn a_lone_or_reversed_surrogate_escape_stays_as_it_is() {
        for text in [
            r"\uD83D",
            r"\uDE00\uD83D",
            r"\uDE00\uDE01",
            r"\uD83Dx",
            r"\u12",
            r"\uZZZZ",
        ] {
            assert_eq!(read(text), text, "{text:?}");
        }
    }

    #[test]
    fn base64_wrapped_into_lines_is_joined_whatever_the_break() {
        for broken in [
            "QUJD\nREVG",
            "QUJD\r\nREVG",
            "QUJD\rREVG",
            r"QUJD\nREVG",
            r"QUJD\r\nREVG",
            r"QUJD\rREVG",
            "QUJD&#10;REVG",
            "QUJD&#13;&#10;REVG",
            "QUJD\n    REVG",
            "QUJD\r\n\tREVG",
        ] {
            assert_eq!(read(broken), "QUJDREVG", "{broken:?}");
        }
    }

    #[test]
    fn a_break_that_does_not_sit_inside_base64_stays() {
        assert_eq!(read("end.\nNext"), "end.\nNext");
        assert_eq!(read("QUJD\n\nREVG"), "QUJD\n\nREVG");
        assert_eq!(read("QUJD \nREVG"), "QUJD \nREVG");
    }

    #[test]
    fn a_span_of_what_was_read_maps_to_the_whole_original_pieces() {
        let text = "x&amp;y&#x41;z";
        let decoded = Decoded::of(text, Layers::ALL).unwrap();
        assert_eq!(decoded.text(), "x&yAz");
        // "&" came from "&amp;", "A" from "&#x41;".
        assert_eq!(decoded.original_span(1, 2), (1, 6));
        assert_eq!(decoded.original_span(3, 4), (7, 13));
        assert_eq!(decoded.original_span(0, 5), (0, 14));
        assert_eq!(decoded.original_span(2, 3), (6, 7));
    }

    #[test]
    fn a_joined_line_maps_back_across_its_break() {
        let text = "QUJD\r\n  REVG";
        let decoded = Decoded::of(text, Layers::ALL).unwrap();
        assert_eq!(decoded.original_span(2, 6), (2, 10));
    }

    #[test]
    fn every_span_maps_to_character_boundaries_of_the_original() {
        let text = "é&#x1F600;ü&eacute;\\u00e9€&#10;QUJD\nREVG&quot;日本";
        let decoded = Decoded::of(text, Layers::ALL).unwrap();
        let read = decoded.text();
        let boundaries: Vec<usize> = (0..=read.len())
            .filter(|at| read.is_char_boundary(*at))
            .collect();
        for &start in &boundaries {
            for &end in boundaries.iter().filter(|end| **end > start) {
                let (from, to) = decoded.original_span(start, end);
                assert!(
                    from < to && to <= text.len(),
                    "{start}..{end} -> {from}..{to}"
                );
                assert!(text.is_char_boundary(from) && text.is_char_boundary(to));
            }
        }
    }
}
