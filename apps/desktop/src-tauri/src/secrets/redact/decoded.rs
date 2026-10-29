//! An answer read the way a reader of it would: entities and JSON escapes
//! decoded, and base64 that was wrapped into lines joined up, with a map from
//! every position in what was read back to the text it came from.

/// The text as read, and where each piece of it came from.
pub struct Decoded {
    text: String,
}

impl Decoded {
    /// `text` read with its entities and escapes decoded and its wrapped lines
    /// joined, or None when nothing in it reads otherwise.
    pub fn of(_text: &str) -> Option<Decoded> {
        None
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    /// The span of the original text that `start..end` of what was read came
    /// from, widened to whole entities, escapes and line breaks.
    pub fn original_span(&self, start: usize, end: usize) -> (usize, usize) {
        (start, end)
    }
}

#[cfg(test)]
mod tests {
    use super::Decoded;

    fn read(text: &str) -> String {
        Decoded::of(text)
            .map(|decoded| decoded.text().to_string())
            .unwrap_or_else(|| text.to_string())
    }

    #[test]
    fn text_with_nothing_to_decode_is_not_read_again() {
        for text in ["plain words", "a&b c", "50% off", "no breaks here"] {
            assert!(Decoded::of(text).is_none(), "{text:?}");
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
        for text in [r"\uD83D", r"\uDE00\uD83D", r"\uD83Dx", r"\u12", r"\uZZZZ"] {
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
        let decoded = Decoded::of(text).unwrap();
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
        let decoded = Decoded::of(text).unwrap();
        assert_eq!(decoded.original_span(2, 6), (2, 10));
    }

    #[test]
    fn every_span_maps_to_character_boundaries_of_the_original() {
        let text = "é&#x1F600;ü&eacute;\\u00e9€&#10;QUJD\nREVG&quot;日本";
        let decoded = Decoded::of(text).unwrap();
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
