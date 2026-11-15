/// dravidian.rs — Telugu via Kannada, and telling the two apart from the words.
///
/// Two problems with Whisper (large-v3-turbo) on these languages:
///
/// 1. Its *Telugu* decoder often produces broken script ("ంస్కారం యల్ా ఉన్నారు!")
///    while the same audio decoded as *Kannada* comes back clean. The two scripts are
///    letter-for-letter parallel in Unicode (Kannada U+0C80.., Telugu U+0C00..), so we
///    decode Telugu speech as Kannada and move the letters across with
///    `kannada_to_telugu`.
/// 2. Its language detector can't separate Telugu from Kannada at all (both score
///    ~0.000; the mass lands on Tamil and Hindi). The words can: once the speech is
///    written down, `looks_telugu` scores tell-tale words and endings of each.
///
/// The detection side (not Hindi, but one of these) lives in `whisper::resolve_language`.

/// Kannada script → Telugu script, letter for letter. Everything else passes through.
pub fn kannada_to_telugu(input: &str) -> String {
    input
        .chars()
        .map(|c| match c {
            '\u{0C80}' => '\u{0C01}',             // spacing candrabindu → candrabindu
            '\u{0CDE}' => '\u{0C2B}',             // archaic "fa" → ఫ
            '\u{0C84}' | '\u{0CF1}'..='\u{0CF3}' => c, // no Telugu counterpart; kept
            '\u{0C81}'..='\u{0CEF}' => char::from_u32(c as u32 - 0x80).unwrap_or(c),
            _ => c,
        })
        .collect()
}

// Words written in Kannada script (that's what the decoder produces for both languages).
const TELUGU_WORDS: &[&str] = &[
    "ನೇನು", "ನುವ್ವು", "ಮೀರು", "ಮೇಮು", "ಮನಂ", "ಮನಮು", "ಏಮಿ", "ಏಂಟಿ", "ಏಂ", "ಎಲಾ", "ಎಲಾಗ",
    "ಲೇದು", "ಕಾದು", "ಉಂದಿ", "ರೇಪು", "ಈರೋಜು", "ಪನಿ", "ಚೇಯಾಲಿ", "ಚೆಯ್ಯಿ", "ಚೆಪ್ಪು",
    "ಚೆಪ್ಪಂಡಿ", "ಅಂಡಿ", "ಗಾರು", "ಇಕ್ಕಡ", "ಅಕ್ಕಡ", "ಎಕ್ಕಡ", "ಎಂದುಕು", "ಅವುನು", "ಸರೇ",
    "ಬಾಗಾ", "ಬಾಗುಂದಿ", "ಚಾಲಾ", "ಇದಿ", "ಅದಿ", "ಎವರು", "ಏದಿ", "ಒಕ್ಕ", "ಕಾನೀ", "ಕಾನಿ",
    "ಕಾಬಟ್ಟಿ", "ಅಯಿಂದಿ", "ಅಯಿಂದಾ", "ಅಯ್ಯಿಂದಿ", "ಎಪ್ಪುಡು", "ಇಪ್ಪುಡು", "ವಸ್ತಾನು", "ವೆಳ್ತಾನು",
];
const KANNADA_WORDS: &[&str] = &[
    "ನಾನು", "ನೀನು", "ಏನು", "ಹೇಗೆ", "ನಾಳೆ", "ನಾಲೆ", "ಇವತ್ತು", "ಇವತ್ತೆ", "ಇದೆ", "ಇಲ್ಲ", "ಇಲ್ಲಾ",
    "ಅಲ್ಲ", "ಬೇಕು", "ಬೇಡ", "ಮಾಡು", "ಮಾಡಿ", "ಹೋಗು", "ಹೋಗಿ", "ಬನ್ನಿ", "ಬಾ", "ಆಯ್ತು", "ಆಯ್ತಾ",
    "ಹೇಳು", "ಹೇಳಿ", "ಗೊತ್ತು", "ಸ್ವಲ್ಪ", "ತುಂಬಾ", "ಚೆನ್ನಾಗಿ", "ಯಾಕೆ", "ಎಲ್ಲಿ", "ಅಲ್ಲಿ",
    "ಇಲ್ಲಿ", "ಇದು", "ಅದು", "ಯಾರು", "ಕೆಲಸ", "ಕೆಲಸಾ", "ಊಟ", "ಸರಿ", "ಏನಾಯ್ತು", "ನಮಸ್ಕಾರ",
];
// Endings: Telugu verbs end in -u/-i (ವಸ್ತಾನು, ತಿಡತಾರು, ಚೇಯಾಲಿ, -ಲೋ "in"), nouns in -am;
// Kannada verbs in -e/-i (ಬರ್ತೀನಿ, ಬಯ್ತಾರೆ) and it says -ಬೇಕು, -ಅಲ್ಲಿ.
const TELUGU_ENDINGS: &[&str] = &["ನ್ನಾರು", "ನ್ನಾವು", "ನ್ನಾನು", "ನ್ನಾಡು", "ನ್ನಾಯಿ", "ತಾನು", "ತಾರು", "ತಾವು", "ಾಲಿ", "ಲೋ"];
const KANNADA_ENDINGS: &[&str] = &["ಬೇಕು", "ತೀನಿ", "ತಿನಿ", "ತೀನೆ", "ತಾರೆ", "ತಾನೆ", "ತಾಳೆ", "ಲ್ಲಿ", "ದ್ದೀರಾ", "ದ್ದಿರಾ", "ದ್ದೀಯಾ", "ದ್ದಿಯ", "ದ್ದೀನಿ"];
const KANNADA_INFIXES: &[&str] = &["ತ್ತಿದ್ದ", "ದ್ದೀ"];

/// Given Kannada-script text from speech that is either Telugu or Kannada, is it Telugu?
/// `telugu_first` settles a tie (the user listed Telugu before Kannada).
pub fn looks_telugu(text: &str, telugu_first: bool) -> bool {
    let (mut te, mut kn) = (0.0f32, 0.0f32);
    for word in text
        .split(|c: char| !(('\u{0C80}'..='\u{0CFF}').contains(&c) || c == '\u{200C}' || c == '\u{200D}'))
        .filter(|w| !w.is_empty())
    {
        if TELUGU_WORDS.contains(&word) { te += 2.0; }
        if KANNADA_WORDS.contains(&word) { kn += 2.0; }
        let long = word.chars().count() > 2;
        if long && TELUGU_ENDINGS.iter().any(|e| word.ends_with(e)) { te += 1.0; }
        if long && KANNADA_ENDINGS.iter().any(|e| word.ends_with(e)) { kn += 1.0; }
        if KANNADA_INFIXES.iter().any(|e| word.contains(e)) { kn += 0.5; }
        // Word-final anusvara (-am: ನಮಸ್ಕಾರಂ, ಭೋಜನಂ, ಏಂ) is Telugu; Kannada writes -a.
        if word.ends_with('ಂ') { te += 1.0; }
        // Final -e (ನಾಳೆ, ಬಯ್ತಾರೆ, ಇವತ್ತೆ) is common in Kannada, rare in Telugu.
        if long && word.ends_with('ೆ') { kn += 0.5; }
    }
    if te == kn { telugu_first } else { te > kn }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_letters_across() {
        assert_eq!(kannada_to_telugu("ನೇನು ರೇಪು ವಸ್ತಾನು."), "నేను రేపు వస్తాను.");
        assert_eq!(kannada_to_telugu("ಭೋಜನಂ ok 12"), "భోజనం ok 12");
    }

    // Kannada-script decodes of real Telugu / Kannada clips.
    #[test]
    fn tells_telugu_from_kannada() {
        for te in [
            "ನೇನು ರೇಪು ಬಸ್ತಾನು.",
            "ಇ ಪನಿ ಇರೋಜೇ ಪೂರ್ತಿ ಚೇಯಾಲಿ ಲೇಕ ಪೋತೇವ ಬೌಸ್ತಿದತಾರು.",
            "ನಾಮಸ್ಕಾರಂ, ಎಲಾ ಹುನ್ನಾರು.",
            "ಯೇಂಟ್ರಾಯೇಂ ಚೆಪ್ತು ನಾವು.",
            "ಎಂಟ್ರಾಯೇಂ ಚೆಪ್ತುನ್ನಾವು ರೇಪು ಉದೆಯಂ ಮನಾವಾವಿಸುಕು ಬೆಲ್ದಾಂ ಬೋಜನಂ ಅಯಿಂದಾ?",
        ] {
            assert!(looks_telugu(te, false), "{te}");
        }
        for kn in [
            "ನಾನು ನಾಲೆ ಬರ್ತಿನಿ.",
            "ಇಕೆಲಸಾ ಇವತ್ತೆ ಮುಗಿಸಬೇಕು, ಇಲಾಂದ್ರೇ ಬೋಸ್ ಬಯಿತಾರೆ.",
            "ನಮಸ್ಕಾರಾ, ಹೇಗದ್ದಿರಾ.",
            "ನಿನು ಇನ್ನು ಹೇಳು ತಿದ್ದಿಯ ನಾಲೆ ಬಳಿಗೆ ನಾಗು ಆಚಿಸಿಗೆ ಹೋಗೊಳನ ಪೊಟ್ರ ಆಯತಾ.",
        ] {
            assert!(!looks_telugu(kn, true), "{kn}");
        }
    }
}
