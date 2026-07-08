/// translit.rs — Deterministic Devanagari (Hindi) → Latin romanization.
///
/// Renders Hindi speech as "English letters" (natural Hinglish) when the
/// auto-romanize toggle is on, e.g. "मैं ठीक हूँ" → "main theek hoon".
/// This is transliteration (same words, Latin script), NOT translation.
/// Any non-Devanagari text (English, digits, punctuation) passes through
/// unchanged, so it is safe to run on every transcript.

fn consonant(c: char) -> Option<&'static str> {
    Some(match c {
        'क' => "k",
        'ख' => "kh",
        'ग' => "g",
        'घ' => "gh",
        'ङ' => "n",
        'च' => "ch",
        'छ' => "chh",
        'ज' => "j",
        'झ' => "jh",
        'ञ' => "n",
        'ट' => "t",
        'ठ' => "th",
        'ड' => "d",
        'ढ' => "dh",
        'ण' => "n",
        'त' => "t",
        'थ' => "th",
        'द' => "d",
        'ध' => "dh",
        'न' => "n",
        'प' => "p",
        'फ' => "ph",
        'ब' => "b",
        'भ' => "bh",
        'म' => "m",
        'य' => "y",
        'र' => "r",
        'ल' => "l",
        'व' => "v",
        'श' => "sh",
        'ष' => "sh",
        'स' => "s",
        'ह' => "h",
        'ळ' => "l",
        // Precomposed nukta consonants (single code points U+0958–U+095F).
        // Decomposed forms (base + U+093C) fall back to the base + dropped nukta.
        '\u{0958}' => "q",
        '\u{0959}' => "kh",
        '\u{095A}' => "gh",
        '\u{095B}' => "z",
        '\u{095C}' => "r",
        '\u{095D}' => "rh",
        '\u{095E}' => "f",
        '\u{095F}' => "y",
        _ => return None,
    })
}

fn independent_vowel(c: char) -> Option<&'static str> {
    Some(match c {
        'अ' => "a",
        'आ' => "aa",
        'इ' => "i",
        'ई' => "ee",
        'उ' => "u",
        'ऊ' => "oo",
        'ऋ' => "ri",
        'ए' => "e",
        'ऐ' => "ai",
        'ओ' => "o",
        'औ' => "au",
        'ऍ' => "e",
        'ऎ' => "e",
        'ऑ' => "o",
        'ऒ' => "o",
        _ => return None,
    })
}

fn matra(c: char) -> Option<&'static str> {
    Some(match c {
        'ा' => "aa",
        'ि' => "i",
        'ी' => "ee",
        'ु' => "u",
        'ू' => "oo",
        'ृ' => "ri",
        'े' => "e",
        'ै' => "ai",
        'ो' => "o",
        'ौ' => "au",
        'ॅ' => "e",
        'ॉ' => "o",
        'ॆ' => "e",
        'ॊ' => "o",
        _ => return None,
    })
}

fn digit(c: char) -> Option<char> {
    Some(match c {
        '०' => '0',
        '१' => '1',
        '२' => '2',
        '३' => '3',
        '४' => '4',
        '५' => '5',
        '६' => '6',
        '७' => '7',
        '८' => '8',
        '९' => '9',
        _ => return None,
    })
}

/// Transliterate a string from Devanagari to Latin. Pass-through for everything else.
pub fn devanagari_to_latin(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    // True when a consonant has been emitted whose inherent 'a' (schwa) is not yet
    // resolved. The schwa is realized as "a" before the next sign, or deleted at a
    // word boundary (Hindi schwa-deletion heuristic).
    let mut pending = false;

    for c in input.chars() {
        if let Some(cons) = consonant(c) {
            if pending {
                out.push('a');
            }
            out.push_str(cons);
            pending = true;
            continue;
        }
        if let Some(m) = matra(c) {
            out.push_str(m);
            pending = false;
            continue;
        }
        if c == '\u{094D}' {
            // Virama / halant: explicitly removes the inherent vowel.
            pending = false;
            continue;
        }
        if let Some(v) = independent_vowel(c) {
            if pending {
                out.push('a');
                pending = false;
            }
            out.push_str(v);
            continue;
        }
        match c {
            '\u{0902}' | '\u{0901}' => {
                // Anusvara / chandrabindu → nasal.
                if pending {
                    out.push('a');
                    pending = false;
                }
                out.push('n');
                continue;
            }
            '\u{0903}' => {
                // Visarga → h.
                if pending {
                    out.push('a');
                    pending = false;
                }
                out.push('h');
                continue;
            }
            // Standalone nukta, ZWNJ/ZWJ, avagraha, om, Vedic accents: drop.
            '\u{093C}'
            | '\u{200C}'
            | '\u{200D}'
            | '\u{093D}'
            | '\u{0950}'
            | '\u{0951}'..='\u{0954}' => {
                continue;
            }
            // Danda / double danda → sentence period.
            '\u{0964}' | '\u{0965}' => {
                pending = false;
                out.push('.');
                continue;
            }
            _ => {}
        }
        if let Some(d) = digit(c) {
            // A digit ends the current akshara; delete the trailing schwa.
            pending = false;
            out.push(d);
            continue;
        }
        // Any other character (Latin, space, punctuation) is a word boundary, so a
        // pending schwa is deleted rather than written.
        pending = false;
        out.push(c);
    }

    out
}

#[cfg(test)]
mod tests {
    use super::devanagari_to_latin as r;

    #[test]
    fn romanizes_common_phrases() {
        assert_eq!(r("मैं ठीक हूँ"), "main theek hoon");
        assert_eq!(r("कैसे हो"), "kaise ho");
        assert_eq!(r("नमस्ते"), "namaste");
        assert_eq!(r("घर"), "ghar"); // final schwa deleted
        assert_eq!(r("कमल"), "kamal"); // medial schwa kept, final deleted
    }

    #[test]
    fn passes_through_non_devanagari() {
        assert_eq!(r("hello world 123"), "hello world 123");
        assert_eq!(r("main theek hoon"), "main theek hoon");
    }

    #[test]
    fn mixed_script() {
        assert_eq!(r("ok मैं ready हूँ"), "ok main ready hoon");
    }
}
