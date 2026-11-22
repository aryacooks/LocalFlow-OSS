//! Render English number phrases in digits before optional dictation formatting.

use once_cell::sync::Lazy;
use regex::{Match, Regex};

const SMALL: &[&str] = &[
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
];
const TENS: &[&str] = &[
    "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];
const SCALES: &[(&str, u64)] = &[
    ("thousand", 1_000),
    ("lakh", 100_000),
    ("million", 1_000_000),
    ("crore", 10_000_000),
    ("billion", 1_000_000_000),
    ("trillion", 1_000_000_000_000),
];

static NUMBER_WORD: Lazy<Regex> = Lazy::new(|| {
    let words = SMALL
        .iter()
        .chain(TENS)
        .copied()
        .chain(SCALES.iter().map(|&(word, _)| word))
        .chain(["hundred", "and", "point", "negative"])
        .collect::<Vec<_>>()
        .join("|");
    Regex::new(&format!(r"(?i)\b(?:{words})\b")).unwrap()
});
static WRITTEN_NUMBER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"-?\b[0-9]+(?:\.[0-9]+)?\b").unwrap());

struct Token<'a> {
    word: Match<'a>,
    gap: &'a str,
}

fn after<'a>(tokens: &'a [Token<'_>], index: usize) -> Option<&'a str> {
    let token = tokens.get(index)?;
    (!token.gap.is_empty() && token.gap.bytes().all(|c| matches!(c, b' ' | b'\t')))
        .then(|| token.word.as_str())
}

fn is_word(word: Option<&str>, expected: &str) -> bool {
    word.is_some_and(|word| word.eq_ignore_ascii_case(expected))
}

fn small(word: &str) -> Option<u64> {
    SMALL
        .iter()
        .position(|entry| word.eq_ignore_ascii_case(entry))
        .map(|n| n as u64)
}

fn under_hundred(tokens: &[Token<'_>], start: usize) -> Option<(u64, usize)> {
    let word = tokens.get(start)?.word.as_str();
    if let Some(value) = small(word) {
        return Some((value, start + 1));
    }
    let tens = TENS
        .iter()
        .position(|entry| word.eq_ignore_ascii_case(entry))?;
    let value = (tens as u64 + 2) * 10;
    let units = tokens.get(start + 1).and_then(|token| {
        let next = after(tokens, start + 1).or_else(|| {
            matches!(token.gap, "-" | "\u{2010}" | "\u{2011}").then(|| token.word.as_str())
        })?;
        small(next).filter(|units| (1..=9).contains(units))
    });
    Some(match units {
        Some(units) => (value + units, start + 2),
        None => (value, start + 1),
    })
}

fn skip_and(tokens: &[Token<'_>], index: usize) -> usize {
    index + usize::from(is_word(after(tokens, index), "and"))
}

fn under_thousand(tokens: &[Token<'_>], start: usize) -> Option<(u64, usize)> {
    let (value, end) = under_hundred(tokens, start)?;
    if !(1..=9).contains(&value) || !is_word(after(tokens, end), "hundred") {
        return Some((value, end));
    }
    let next = skip_and(tokens, end + 1);
    if after(tokens, next).is_some() {
        if let Some((remainder, remainder_end)) = under_hundred(tokens, next) {
            if remainder > 0 && !is_word(after(tokens, remainder_end), "hundred") {
                return Some((value * 100 + remainder, remainder_end));
            }
        }
    }
    Some((value * 100, end + 1))
}

fn integer(tokens: &[Token<'_>], start: usize) -> Option<(u64, usize)> {
    let mut total = 0;
    let mut last_scale = u64::MAX;
    let mut index = start;
    let mut end = start;
    while let Some((value, next)) = under_thousand(tokens, index) {
        let scale = after(tokens, next).and_then(|word| {
            SCALES
                .iter()
                .find(|&&(name, _)| word.eq_ignore_ascii_case(name))
        });
        let Some(&(_, scale)) = scale else {
            if value == 0 && total > 0 {
                break;
            }
            return Some((total + value, next));
        };
        if scale >= last_scale || value == 0 || value * scale >= last_scale {
            break;
        }
        total += value * scale;
        last_scale = scale;
        end = next + 1;
        index = skip_and(tokens, end);
        if after(tokens, index).is_none() {
            break;
        }
    }
    (end > start).then_some((total, end))
}

fn number(tokens: &[Token<'_>], start: usize) -> Option<(String, usize)> {
    let negative = tokens[start].word.as_str().eq_ignore_ascii_case("negative");
    let first = start + usize::from(negative);
    if negative {
        after(tokens, first)?;
    }
    let (value, mut end) = integer(tokens, first)?;
    let mut digits = value.to_string();
    if negative {
        digits.insert(0, '-');
    }
    if is_word(after(tokens, end), "point") {
        let mut decimal = end + 1;
        while let Some(digit) = after(tokens, decimal).and_then(small).filter(|&n| n < 10) {
            if decimal == end + 1 {
                digits.push('.');
            }
            digits.push(char::from(b'0' + digit as u8));
            decimal += 1;
        }
        if decimal > end + 1 {
            end = decimal;
        }
    }
    Some((digits, end))
}

pub fn normalize(text: &str) -> String {
    replace_number_words(text, |_| true)
}

/// Keep the recognizer's numeric notation when an AI rewrite spells it out.
pub fn restore_digits(text: String, original: &str) -> String {
    let written: std::collections::HashSet<_> = WRITTEN_NUMBER
        .find_iter(original)
        .map(|number| number.as_str())
        .collect();
    if written.is_empty() {
        return text;
    }
    replace_number_words(&text, |digits| written.contains(digits))
}

fn replace_number_words(text: &str, replace: impl Fn(&str) -> bool) -> String {
    let mut previous = 0;
    let tokens: Vec<_> = NUMBER_WORD
        .find_iter(text)
        .filter(|word| {
            // Skip parts of possessives, contractions, and words joined by an apostrophe.
            let preceded_by_word = text[..word.start()]
                .strip_suffix(['\'', '’'])
                .is_some_and(|prefix| prefix.ends_with(char::is_alphanumeric));
            let followed_by_word = text[word.end()..]
                .strip_prefix(['\'', '’'])
                .is_some_and(|suffix| suffix.starts_with(char::is_alphanumeric));
            !preceded_by_word && !followed_by_word
        })
        .map(|word| {
            let gap = &text[previous..word.start()];
            previous = word.end();
            Token { word, gap }
        })
        .collect();

    let mut output = String::with_capacity(text.len());
    let mut copied = 0;
    let mut index = 0;
    while index < tokens.len() {
        if let Some((digits, end)) = number(&tokens, index) {
            let start_byte = tokens[index].word.start();
            let end_byte = tokens[end - 1].word.end();
            // A bare "one" in a sentence can be a pronoun ("one of us").
            if replace(&digits)
                && (digits != "1" || numeric_one(&text[..start_byte], &text[end_byte..]))
            {
                output.push_str(&text[copied..start_byte]);
                output.push_str(&digits);
                copied = end_byte;
            }
            index = end;
        } else {
            index += 1;
        }
    }
    output.push_str(&text[copied..]);
    output
}

fn numeric_one(before: &str, after: &str) -> bool {
    let standalone =
        !before.contains(char::is_alphanumeric) && !after.contains(char::is_alphanumeric);
    let suffix = after.trim_start_matches([' ', '\t']);
    standalone
        || suffix.starts_with('%')
        || suffix
            .split(|ch: char| !ch.is_alphanumeric())
            .next()
            .is_some_and(|word| word.eq_ignore_ascii_case("percent"))
}

#[cfg(test)]
mod tests {
    use super::normalize;

    #[test]
    fn renders_spoken_numbers_in_digits() {
        for (input, expected) in [
            ("Fifty.", "50."),
            ("I need fifty copies by five.", "I need 50 copies by 5."),
            (
                "x equals twenty-five plus one hundred and fifty",
                "x equals 25 plus 150",
            ),
            ("two thousand three hundred and six", "2306"),
            ("one crore twenty-five lakh", "12500000"),
            ("negative fifty point zero five percent", "-50.05 percent"),
            ("one", "1"),
            ("one percent", "1 percent"),
            ("one hundred and two hundred", "100 and 200"),
        ] {
            assert_eq!(normalize(input), expected);
        }
    }

    #[test]
    fn respects_word_and_phrase_boundaries() {
        for (input, expected) in [
            ("one of us has 50.05%", "one of us has 50.05%"),
            ("anyone or no one", "anyone or no one"),
            ("twenty\nfive", "20\n5"),
            ("twenty-year-old", "20-year-old"),
            (
                "The point is that 'fifty' works.",
                "The point is that '50' works.",
            ),
            (
                "Fifty and Two's shared folder",
                "50 and Two's shared folder",
            ),
        ] {
            assert_eq!(normalize(input), expected);
        }
    }
}
