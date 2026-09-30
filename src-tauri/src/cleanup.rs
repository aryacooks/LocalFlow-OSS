use once_cell::sync::Lazy;
/// cleanup.rs — AI text cleanup using regex fallback
/// The LLM (llama.cpp) path is wired but falls back to regex if model not loaded.
/// This satisfies the requirement for graceful degradation.
use regex::Regex;

// ── Filler words ────────────────────────────────────────────────────────────
// Filler removal used to be one big alternation applied everywhere, which ate
// meaningful words: "ok right now" lost both "ok" and "right" and came out as
// just "now". Most of these words are only filler in a particular position, so
// the decision is made per-occurrence instead of per-word:
//
//  • NOISE     — non-words ("um", "uh", "hmm"). Dropped anywhere.
//  • DISCOURSE — real words that are filler only when they open a clause AND are
//                set off by a comma (or hug a NOISE token). "So, we shipped it"
//                loses "so"; "so that works" keeps it; "right now" keeps "right"
//                because no comma follows it.
//  • TAIL      — trailing tags ("you know", "i mean"), also filler at the very
//                end of the text, but only after a clause break so questions
//                like "do you know" survive.
//  • HEDGE     — "kind of"/"sort of", dropped unless the neighbouring words show
//                the literal noun sense ("what kind of person").
//
// Anything genuinely load-bearing ("I think", "I feel like") is not on any list.

/// Sounds that are never real words.
const NOISE: &[&str] = &[
    "um", "umm", "ummm", "uh", "uhh", "uhhh", "uhm", "erm", "hmm", "hmmm", "mmm", "mhm",
];

/// Longest-first so "you know" wins before a bare word could half-match.
const DISCOURSE: &[&[&str]] = &[
    &["to", "tell", "you", "the", "truth"],
    &["at", "the", "end", "of", "the", "day"],
    &["to", "be", "honest"],
    &["you", "know"],
    &["i", "mean"],
    &["you", "see"],
    &["i", "guess"],
    &["anyway"],
    &["actually"],
    &["basically"],
    &["literally"],
    &["honestly"],
    &["seriously"],
    &["obviously"],
    &["okay"],
    &["ok"],
    &["right"],
    &["well"],
    &["so"],
    &["like"],
    &["look"],
];

/// Discourse markers that are also filler when they trail the whole utterance.
const TAIL: &[&[&str]] = &[&["you", "know"], &["i", "mean"], &["you", "see"]];

const HEDGE: &[&[&str]] = &[&["kind", "of"], &["sort", "of"]];

/// Words before a hedge that make it the literal noun sense ("what kind of …").
const HEDGE_KEEP_LEFT: &[&str] = &[
    "what", "which", "this", "that", "these", "those", "some", "any", "a", "an", "the", "every",
    "each", "no", "another", "certain",
];

/// Words after a hedge that make it the literal noun sense ("… kind of person").
const HEDGE_KEEP_RIGHT: &[&str] = &[
    "a", "an", "the", "thing", "things", "person", "people", "stuff", "way", "ways", "day", "guy",
    "man", "woman", "music", "food", "work", "job", "deal", "life",
];

/// Lowercased alphanumeric core of a token, ignoring attached punctuation.
fn core_of(tok: &str) -> String {
    tok.chars()
        .filter(|c| c.is_alphanumeric() || *c == '\'')
        .collect::<String>()
        .to_lowercase()
}

/// Does this token end a clause? Closing quotes/brackets are looked through.
fn ends_with_break(tok: &str) -> bool {
    tok.trim_end_matches(|c: char| matches!(c, '"' | '\'' | ')' | ']' | '}'))
        .ends_with([
            '.', ',', '!', '?', ';', ':', '\u{2014}', '\u{2013}', '\u{201d}',
        ])
}

fn ends_with_comma(tok: &str) -> bool {
    tok.trim_end_matches(|c: char| matches!(c, '"' | '\'' | ')' | ']' | '}'))
        .ends_with([',', '\u{2014}', '\u{2013}'])
}

fn phrase_at(cores: &[String], i: usize, phrase: &[&str]) -> bool {
    i + phrase.len() <= cores.len() && phrase.iter().enumerate().all(|(k, w)| cores[i + k] == *w)
}

/// How many tokens starting at `i` are filler, if any. `kept` is the output so far
/// (position is judged against the surviving text, so "um so, yeah" still sees "so"
/// as clause-initial once "um" has been dropped).
fn filler_len(toks: &[&str], cores: &[String], kept: &[String], i: usize) -> Option<usize> {
    if NOISE.contains(&cores[i].as_str()) {
        return Some(1);
    }

    let clause_start = kept.last().map(|t| ends_with_break(t)).unwrap_or(true);

    for phrase in HEDGE {
        if !phrase_at(cores, i, phrase) {
            continue;
        }
        let prev = kept.last().map(|t| core_of(t)).unwrap_or_default();
        let next = cores.get(i + phrase.len()).cloned().unwrap_or_default();
        if !HEDGE_KEEP_LEFT.contains(&prev.as_str()) && !HEDGE_KEEP_RIGHT.contains(&next.as_str()) {
            return Some(phrase.len());
        }
    }

    for phrase in DISCOURSE {
        if !phrase_at(cores, i, phrase) {
            continue;
        }
        let end = i + phrase.len();
        let set_off = ends_with_comma(toks[end - 1]);
        let hugs_noise = cores.get(end).is_some_and(|c| NOISE.contains(&c.as_str()));
        let at_tail = end == toks.len() && TAIL.contains(phrase);
        if clause_start && (set_off || hugs_noise || at_tail) {
            return Some(phrase.len());
        }
    }

    None
}

/// Drop filler words, keeping every word that is doing real work.
fn strip_fillers(text: &str) -> String {
    let toks: Vec<&str> = text.split_whitespace().collect();
    let cores: Vec<String> = toks.iter().map(|t| core_of(t)).collect();
    let mut out: Vec<String> = Vec::with_capacity(toks.len());

    let mut i = 0;
    while i < toks.len() {
        if let Some(len) = filler_len(&toks, &cores, &out, i) {
            // A terminator riding on the dropped phrase belongs to the sentence, not
            // to the filler: "it was weird, you know." must keep its full stop.
            if let Some(last_char) = toks[i + len - 1].chars().last() {
                if matches!(last_char, '.' | '!' | '?') {
                    if let Some(prev) = out.last_mut() {
                        if prev.ends_with([',', ';', ':']) {
                            // The comma was there to set off the filler; the sentence
                            // ends here now, so it becomes the terminator.
                            prev.pop();
                            prev.push(last_char);
                        } else if !prev.ends_with(['.', '!', '?']) {
                            prev.push(last_char);
                        }
                    }
                }
            }
            i += len;
            continue;
        }
        out.push(toks[i].to_string());
        i += 1;
    }

    out.join(" ")
}

// ── Spoken self-corrections ─────────────────────────────────────────────────
// Collapse "<wrong> <cue> <right>" → "<right>", e.g.
//   "meet at 6pm no actually at 8pm" → "meet at 8pm"
//   "let's meet at 6, sorry, 8"      → "let's meet at 8"
// The cue names the mistake; the value right after it replaces the value right
// before it. We keep whichever connector (at/to/on/…) is present so we never
// leave a dangling or doubled preposition.
//
// Two passes, ordered safest-first:
//  • COMPOUND: unambiguous multi-word cues ("no wait", "no actually", "i mean",
//    "or rather", …) — safe to match without surrounding punctuation.
//  • DELIMITED: risky single words ("sorry", "no", "wait", "actually") only when
//    a comma/dash sits right before them, so ordinary prose like "I said no to
//    him" or "I'm sorry about that" is left alone.
//
// `c1` = connector before the wrong value, `c2` = connector before the right
// value. The wrong value is limited to 1–2 tokens so it can't swallow the verb.
static CORRECTION_COMPOUND_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(concat!(
        r"(?i)",
        r"(?P<c1>(?:at|to|on|in|by|for|with|from|around)\s+)?",
        r"(?P<wrong>\S+(?:\s+\S+)??)",
        r"\s*[,\x{2014}\x{2013}-]*\s*",
        r"(?:no\s+wait|no\s+actually|actually\s+no|(?:no\s+)?i\s+mean|(?:no\s+)?i\s+meant|or\s+rather|or\s+actually)",
        r"\s*[,\x{2014}\x{2013}-]*\s*",
        r"(?P<c2>(?:at|to|on|in|by|for|with|from|around)\s+)?",
    ))
    .unwrap()
});

static CORRECTION_DELIMITED_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(concat!(
        r"(?i)",
        r"(?P<c1>(?:at|to|on|in|by|for|with|from|around)\s+)?",
        r"(?P<wrong>\S+(?:\s+\S+)??)",
        r"\s*",
        // Single-word cue is only treated as a correction when a comma/dash hugs it on
        // at least one side — this keeps "I said no to him" / "I'm sorry about that"
        // untouched while catching "6, sorry, 8" and "bob sorry, to jim".
        r"(?:",
        r"[,\x{2014}\x{2013}-]+\s*(?:sorry|wait|actually|no)\b",
        r"|(?:sorry|wait|actually|no)\b\s*[,\x{2014}\x{2013}-]+",
        r")",
        r"\s*[,\x{2014}\x{2013}-]*\s*",
        r"(?P<c2>(?:at|to|on|in|by|for|with|from|around)\s+)?",
    ))
    .unwrap()
});

/// Replacement for a matched self-correction: keep the connector that precedes the
/// *right* value (`c2`) if there is one, otherwise keep the connector that preceded
/// the *wrong* value (`c1`). Everything else in the match (the wrong value + the cue)
/// is dropped. Returning `c2`/`c1` leaves the surrounding text and spacing intact.
fn correction_pick(caps: &regex::Captures) -> String {
    let c2 = caps.name("c2").map(|m| m.as_str()).unwrap_or("");
    if !c2.trim().is_empty() {
        return c2.to_string();
    }
    caps.name("c1")
        .map(|m| m.as_str())
        .unwrap_or("")
        .to_string()
}

/// Apply spoken self-corrections, compound cues first then delimited single-word cues.
/// Runs before filler removal so cues like "i mean"/"actually" are consumed here rather
/// than silently stripped as fillers (which would leave both values in the text).
fn resolve_corrections(input: &str) -> String {
    let text = CORRECTION_COMPOUND_RE
        .replace_all(input, correction_pick)
        .into_owned();
    CORRECTION_DELIMITED_RE
        .replace_all(&text, correction_pick)
        .into_owned()
}

/// Determine the context category from executable name
pub fn app_context(exe: &str) -> &'static str {
    match exe.to_lowercase().as_str() {
        "slack.exe" | "discord.exe" | "whatsapp.exe" | "telegram.exe" => "casual",
        "chrome.exe" | "msedge.exe" | "firefox.exe" => "neutral",
        "outlook.exe" | "winword.exe" => "formal",
        "code.exe" | "cursor.exe" | "windowsterminal.exe" | "powershell.exe" | "cmd.exe" => "code",
        "notion.exe" | "obsidian.exe" => "notes",
        _ => "neutral",
    }
}

/// Regex-based cleanup as graceful degradation fallback
pub fn regex_cleanup(raw: &str) -> String {
    // Resolve spoken self-corrections first, before fillers are stripped (some cues,
    // e.g. "i mean"/"actually", are also filler words).
    let mut text = resolve_corrections(raw);

    // Remove filler words
    text = strip_fillers(&text);

    // Basic sentence casing
    text = sentence_case(&text);

    // Clean up extra spaces
    text = text.split_whitespace().collect::<Vec<_>>().join(" ");

    // NOTE: terminal punctuation is deliberately NOT added here. Spoken commands
    // ("question mark", "exclamation mark") have not been resolved yet, so adding
    // a full stop now produces "Are you sure?." once they are. `finalize_dictation`
    // adds it after, when the real ending is known.
    text.trim().to_string()
}

fn sentence_case(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut capitalize_next = true;

    for ch in text.chars() {
        if capitalize_next && ch.is_alphabetic() {
            result.extend(ch.to_uppercase());
            capitalize_next = false;
        } else {
            result.push(ch);
            if matches!(ch, '.' | '!' | '?') {
                capitalize_next = true;
            }
        }
    }

    result
}

// ── Spoken commands ────────────────────────────────────────────────────────
// Lets users structure text by voice: "new line", "new paragraph", "comma",
// "period"/"full stop", "question mark", "exclamation mark", "colon",
// "semicolon", plus "scratch that" / "delete that" to drop the last clause.
// Notation ("x equals 50", "open paren", "dollar sign") is handled separately,
// just below — see the Spoken symbols and operators section for why it needs
// different rules.
// Applied to the FINAL cleaned text (both LLM and regex paths) in `cleanup_text`,
// never in command mode. Tradeoff: literally dictating one of these words gets
// converted — this is the standard dictation behavior.

// "scratch/delete/cancel that" → remove the preceding clause.
static CMD_DELETE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\b(?:scratch|delete|cancel|ignore)\s+that\b").unwrap());

// (pattern, replacement). Multi-word phrases MUST come before single words so
// e.g. "semicolon" isn't half-matched by "colon". `\s*` before each swallows the
// space that preceded the spoken word so punctuation hugs the previous token.
static SPOKEN_SUBS: Lazy<Vec<(Regex, &'static str)>> = Lazy::new(|| {
    let p = |re: &str| Regex::new(re).unwrap();
    vec![
        (p(r"(?i)\s*\bnew\s+paragraph\b\s*"), "\n\n"),
        (p(r"(?i)\s*\b(?:new|next)\s+line\b\s*"), "\n"),
        (p(r"(?i)\s*\bquestion\s+mark\b"), "?"),
        // "explanation mark/point" is not a slip of the tongue — it is what Whisper
        // reliably hears for "exclamation mark", so the spoken command silently failed.
        (
            p(r"(?i)\s*\b(?:exclamation|explanation)\s+(?:mark|point)\b"),
            "!",
        ),
        (p(r"(?i)\s*\b(?:full\s+stop|full-stop)\b"), "."),
        (p(r"(?i)\s*\bsemi[\s-]?colon\b"), ";"),
        (p(r"(?i)\s*\bcomma\b"), ","),
        (p(r"(?i)\s*\bperiod\b"), "."),
        (p(r"(?i)\s*\bcolon\b"), ":"),
    ]
});


// ── Spoken symbols and operators ───────────────────────────────────────────
// Turns dictated notation into the characters people mean: "x equals 50" → "x = 50",
// "open paren note close paren" → "(note)", "dollar sign 50" → "$50".
//
// Split into two classes, because the risk is not remotely uniform.
//
// NAMED symbols ("asterisk", "dollar sign", "open paren", "equals sign") are phrases
// nobody says by accident, so they convert wherever they appear — same bargain the
// punctuation words above already make.
//
// BARE operators ("equals", "plus", "times", "less than") are ordinary English. A count
// over real dictation history found "less than" 11 times, "plus" 7 and "times" 4, nearly
// all of it prose — "plus, we shipped it", "three times faster", "less than ideal".
// Converting those on sight would wreck more text than it fixed, so they convert ONLY
// between two operands (see `is_operand`). That is enough for "x equals 50" while
// leaving English alone.
//
// Patterns use `[ \t]*` rather than `\s*` so a substitution can never swallow a newline
// the speaker asked for with "new line".

/// Is this token maths rather than prose?
///
/// A number, or a single letter standing in for a variable. "a", "A" and "I" are
/// deliberately excluded: they are English words, and without that exclusion
/// "5 times a day" becomes "5 * a day" — the single most likely false positive here.
fn is_operand(tok: &str) -> bool {
    if matches!(tok, "a" | "A" | "I") {
        return false;
    }
    let mut chars = tok.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_alphabetic() {
            return true;
        }
    }
    // A number, possibly decimal. Rejects bare "." and version-like "1.2.3".
    tok.chars().any(|c| c.is_ascii_digit())
        && tok.chars().all(|c| c.is_ascii_digit() || c == '.')
        && tok.matches('.').count() <= 1
        && !tok.ends_with('.')
}

// (pattern, symbol). The capture groups are the candidate operands either side; the
// substitution only happens when `is_operand` accepts both. Longer phrases first, so
// "greater than or equal to" is not half-matched by "greater than".
static SPOKEN_OPERATORS: Lazy<Vec<(Regex, &'static str)>> = Lazy::new(|| {
    let op = |spoken: &str, sym: &'static str| {
        (
            Regex::new(&format!(
                // A decimal is part of the operand ("3.5"), but a sentence-ending period
                // is not: capturing "80." in "x equals 80." made the operand check fail
                // and the last clause of a sentence silently kept the spoken word.
                r"(?i)([A-Za-z0-9]+(?:\.[0-9]+)?)[ \t]+(?:{})[ \t]+([A-Za-z0-9]+(?:\.[0-9]+)?)",
                spoken
            ))
            .unwrap(),
            sym,
        )
    };
    vec![
        op(r"greater\s+than\s+or\s+equal\s+to", ">="),
        op(r"less\s+than\s+or\s+equal\s+to", "<="),
        op(r"(?:is\s+)?equal\s+to", "="),
        op(r"to\s+the\s+power\s+of", "^"),
        op(r"multiplied\s+by", "*"),
        op(r"divided\s+by", "/"),
        op(r"greater\s+than", ">"),
        op(r"less\s+than", "<"),
        op(r"equals", "="),
        op(r"plus", "+"),
        op(r"minus", "-"),
        op(r"times", "*"),
        op(r"modulo", "%"),
    ]
});

// "50 percent" → "50%". One-sided: a number immediately before "percent" is a strong
// enough signal on its own, while "the percent of users" keeps its word.
static SPOKEN_PERCENT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\b([0-9]+(?:\.[0-9]+)?)[ \t]+percent\b").unwrap());

// Named symbols, always converted. Grouped by how they sit against neighbouring words:
// spaced like an operator, hugging the token to their left, to their right, or both.
// Order matters — longer phrases first.
static SPOKEN_SYMBOLS: Lazy<Vec<(Regex, &'static str)>> = Lazy::new(|| {
    let p = |re: &str| Regex::new(re).unwrap();
    vec![
        // — spaced —
        (p(r"(?i)[ \t]*\bplus\s+or\s+minus\b[ \t]*"), " ± "),
        (p(r"(?i)[ \t]*\bequals?\s+sign\b[ \t]*"), " = "),
        (p(r"(?i)[ \t]*\bplus\s+sign\b[ \t]*"), " + "),
        (p(r"(?i)[ \t]*\bminus\s+sign\b[ \t]*"), " - "),
        (p(r"(?i)[ \t]*\b(?:times|multiplication)\s+sign\b[ \t]*"), " * "),
        (p(r"(?i)[ \t]*\bdivision\s+sign\b[ \t]*"), " / "),
        (p(r"(?i)[ \t]*\bampersand\b[ \t]*"), " & "),
        (p(r"(?i)[ \t]*\basterisk\b[ \t]*"), " * "),
        (p(r"(?i)[ \t]*\b(?:vertical\s+bar|pipe\s+symbol)\b[ \t]*"), " | "),
        (p(r"(?i)[ \t]*\bem[\s-]?dash\b[ \t]*"), " — "),
        (p(r"(?i)[ \t]*\ben[\s-]?dash\b[ \t]*"), " – "),
        // — hug the token on the LEFT —
        (p(r"(?i)[ \t]*\b(?:percent|percentage)\s+sign\b"), "%"),
        (p(r"(?i)[ \t]*\bdegrees?\s+sign\b"), "°"),
        (p(r"(?i)[ \t]*\b(?:ellipsis|dot\s+dot\s+dot)\b"), "…"),
        (
            p(r"(?i)[ \t]*\b(?:close|closing|right)\s+(?:paren|parenthesis|parentheses)\b"),
            ")",
        ),
        (
            p(r"(?i)[ \t]*\b(?:close|closing|right)\s+(?:square\s+)?bracket\b"),
            "]",
        ),
        (
            p(r"(?i)[ \t]*\b(?:close|closing|right)\s+(?:curly\s+)?(?:brace|bracket)\b"),
            "}",
        ),
        (p(r"(?i)[ \t]*\b(?:close|closing)\s+quote\b"), "\""),
        // — hug the token on the RIGHT —
        (p(r"(?i)[ \t]*\bdollar\s+sign\b[ \t]*"), " $$"),
        (
            p(r"(?i)[ \t]*\b(?:hash\s*tag|hash\s+sign|pound\s+sign|number\s+sign)\b[ \t]*"),
            " #",
        ),
        (
            p(r"(?i)[ \t]*\b(?:open|left)\s+(?:paren|parenthesis|parentheses)\b[ \t]*"),
            " (",
        ),
        (
            p(r"(?i)[ \t]*\b(?:open|left)\s+(?:square\s+)?bracket\b[ \t]*"),
            " [",
        ),
        (
            p(r"(?i)[ \t]*\b(?:open|left)\s+(?:curly\s+)?(?:brace|bracket)\b[ \t]*"),
            " {",
        ),
        (p(r"(?i)[ \t]*\bopen\s+quote\b[ \t]*"), " \""),
        // — hug BOTH sides —
        (p(r"(?i)[ \t]*\b(?:at\s+sign|at\s+symbol)\b[ \t]*"), "@"),
        (p(r"(?i)[ \t]*\bunderscore\b[ \t]*"), "_"),
        (p(r"(?i)[ \t]*\bback[\s-]?slash\b[ \t]*"), "\\"),
        (p(r"(?i)[ \t]*\bforward\s+slash\b[ \t]*"), "/"),
        (p(r"(?i)[ \t]*\bcaret\b[ \t]*"), "^"),
        (p(r"(?i)[ \t]*\btilde\b[ \t]*"), "~"),
        (p(r"(?i)[ \t]*\bback[\s-]?tick\b[ \t]*"), "`"),
        (
            p(r"(?i)[ \t]*\b(?:double\s+quote|quotation\s+mark)\b[ \t]*"),
            "\"",
        ),
        (p(r"(?i)[ \t]*\b(?:single\s+quote|apostrophe)\b[ \t]*"), "'"),
    ]
});

/// Convert dictated notation into symbols: named symbols anywhere, bare operators only
/// between two operands.
fn apply_spoken_symbols(input: &str) -> String {
    let mut text = input.to_string();

    for (re, rep) in SPOKEN_SYMBOLS.iter() {
        text = re.replace_all(&text, *rep).to_string();
    }

    text = SPOKEN_PERCENT_RE.replace_all(&text, "${1}%").to_string();

    for (re, sym) in SPOKEN_OPERATORS.iter() {
        // A chain ("1 plus 2 plus 3") needs more than one pass: the first match consumes
        // the operand its neighbour would need on the left, so the second operator is
        // only reachable once that pass is done. Bounded so nothing can spin.
        for _ in 0..8 {
            let next = re
                .replace_all(&text, |caps: &regex::Captures| {
                    if is_operand(&caps[1]) && is_operand(&caps[2]) {
                        format!("{} {} {}", &caps[1], sym, &caps[2])
                    } else {
                        caps[0].to_string()
                    }
                })
                .to_string();
            if next == text {
                break;
            }
            text = next;
        }
    }

    text
}

// Tidy passes run after substitution. Only pull punctuation left when it behaves like
// punctuation (followed by whitespace/end); keep token prefixes such as `!important`
// and `.class` byte-for-byte.
static SPACE_BEFORE_PUNCT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[ \t]+([,.;:!?]+)([ \t\r\n]|$)").unwrap());
static MULTISPACE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[ \t]{2,}").unwrap());
static AROUND_NL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[ \t]*\n[ \t]*").unwrap());
static MULTI_NL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\n{3,}").unwrap());
// Small local models occasionally return the right rewrite with punctuation from a
// deleted sentence still at the front, e.g. ". Let's meet today.". Only remove an
// orphan run followed by whitespace, so valid code-like text such as `!important`
// remains untouched.
static LEADING_ORPHAN_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*[.,;:!?]+(?:\s+|$)").unwrap());
// A newline followed only by stray punctuation at the very end (e.g. regex_cleanup
// auto-appended a "." after a trailing "new line").
static TAIL_ORPHAN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\n[ \t]*[.,;:!?]+\s*$").unwrap());

/// Convert spoken punctuation/formatting commands into real characters.
pub fn apply_spoken_commands(input: &str) -> String {
    // 1. Deletions: drop everything from the previous clause boundary up to and
    //    including the "scratch that". Iterates because each edit shifts indices.
    let mut text = input.to_string();
    while let Some(m) = CMD_DELETE_RE.find(&text) {
        let (start, end) = (m.start(), m.end());
        // The clause to delete sits right before "scratch that", possibly ending in
        // its own punctuation. Ignore that trailing punctuation/space, then delete
        // back to the boundary that STARTS the clause.
        let before = &text[..start];
        let clause = before.trim_end_matches(|c: char| {
            c.is_whitespace() || matches!(c, '.' | ',' | '!' | '?' | ';' | ':')
        });
        let boundary = clause
            .rfind(|c: char| matches!(c, '.' | '!' | '?' | '\n' | ',' | ';' | ':'))
            .map(|i| i + 1)
            .unwrap_or(0);
        // Whisper and the cleanup model usually punctuate the editing command itself:
        // "Cancel that. Next sentence" or "cancel that, next clause". That punctuation
        // belongs to the command, not the retained text, so consume it together with
        // surrounding whitespace before joining the two surviving pieces.
        let after = text[end..]
            .trim_start_matches(|c: char| {
                c.is_whitespace()
                    || matches!(
                        c,
                        '.' | ',' | '!' | '?' | ';' | ':' | '-' | '\u{2013}' | '\u{2014}'
                    )
            })
            .to_string();
        text.truncate(boundary);
        if !text.is_empty()
            && !after.is_empty()
            && !text.chars().last().is_some_and(char::is_whitespace)
        {
            text.push(' ');
        }
        text.push_str(&after);
    }

    // 2. Punctuation + line-break words → characters.
    for (re, rep) in SPOKEN_SUBS.iter() {
        text = re.replace_all(&text, *rep).to_string();
    }

    // 2b. Notation: named symbols, then bare operators between operands.
    text = apply_spoken_symbols(&text);

    // 3. Tidy spacing without clobbering intentional newlines.
    text = SPACE_BEFORE_PUNCT_RE.replace_all(&text, "$1$2").to_string();
    text = MULTISPACE_RE.replace_all(&text, " ").to_string();
    text = AROUND_NL_RE.replace_all(&text, "\n").to_string();
    text = MULTI_NL_RE.replace_all(&text, "\n\n").to_string();
    text = text.trim().to_string();
    text = TAIL_ORPHAN_RE.replace(&text, "").trim_end().to_string();
    text = LEADING_ORPHAN_RE
        .replace(&text, "")
        .trim_start()
        .to_string();

    // 4. Re-capitalize sentence starts and the first word of each new line.
    recapitalize(&text)
}

/// Capitalize the first letter and sentence starts after `.`/`!`/`?` plus whitespace.
/// Requiring a separator keeps punctuation inside tokens intact (`example.com`,
/// `!important`) while newlines always begin a new sentence.
fn recapitalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cap_next = true;
    let mut sentence_has_content = false;
    let mut terminal_pending = false;

    for ch in text.chars() {
        if cap_next && ch.is_alphabetic() {
            out.extend(ch.to_uppercase());
            cap_next = false;
            sentence_has_content = true;
            terminal_pending = false;
            continue;
        }

        out.push(ch);
        if ch == '\n' {
            cap_next = true;
            sentence_has_content = false;
            terminal_pending = false;
        } else if matches!(ch, '.' | '!' | '?') {
            if sentence_has_content {
                terminal_pending = true;
            } else if cap_next {
                // Leading token punctuation is not a sentence (`!important`, `.class`).
                cap_next = false;
            }
        } else if ch.is_whitespace() {
            if terminal_pending {
                cap_next = true;
                sentence_has_content = false;
            }
        } else {
            terminal_pending = false;
            if ch.is_alphanumeric() {
                sentence_has_content = true;
            }
            if cap_next && !matches!(ch, '"' | '\'' | '(' | '[' | '{') {
                cap_next = false;
            }
        }
    }
    out
}

// A full stop stranded after a stronger mark, e.g. "Are you sure?." — happens when
// something appended a period before "question mark" became "?".
static TERMINAL_DUP_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"([!?])\.+").unwrap());

// Spoken words that place a full stop deliberately. When one of these ends the raw
// dictation the final period is the user's own, so it is kept.
static SPOKEN_PERIOD_TAIL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\b(?:full[\s-]*stop|period)\s*$").unwrap());

/// Drop the sentence-ending full stop from the very end of a dictation.
///
/// Only the last character is considered, so periods that separate sentences
/// inside the text stay put, as do ones inside a token ("example.com"). "?" and
/// "!" are not full stops and are never removed, and an ellipsis is left whole —
/// taking one dot off three just looks broken.
fn strip_trailing_period(text: &str) -> String {
    let text = text.trim_end();
    if !text.ends_with('.') || text.ends_with("..") {
        return text.to_string();
    }
    text[..text.len() - 1].trim_end().to_string()
}

/// Final post-processing applied to dictated text before injection: strip any LLM
/// wrapping, resolve spoken commands, then settle the ending.
///
/// Order matters. Spoken "question mark"/"exclamation mark" become real `?`/`!`
/// here, so the ending is only known once `apply_spoken_commands` has run.
///
/// Dictation is not prose — it lands in chat boxes, search fields and commit
/// messages where a trailing full stop reads as stiff, and it is far easier to
/// type one than to delete one. So the ending period is removed rather than
/// added, unless the user asked for it out loud.
fn finalize_dictation(text: &str) -> String {
    let unwrapped = trim_surrounding_quotes(text);
    let spoken_period_ending = SPOKEN_PERIOD_TAIL_RE.is_match(unwrapped.trim_end());
    let text = apply_spoken_commands(&unwrapped);
    let text = TERMINAL_DUP_RE.replace_all(&text, "$1").into_owned();
    let text = text.trim_end();
    if spoken_period_ending {
        return text.to_string();
    }
    strip_trailing_period(text)
}

/// Build the LLM cleanup prompt
pub fn build_cleanup_prompt(raw_text: &str, app_exe: &str, style_note: &str) -> String {
    let context = app_context(app_exe);
    let context_hint = match context {
        "casual" => "casual chat style (Slack/Discord/WhatsApp). Keep it concise, lowercase is fine, use contractions.",
        "formal" => "formal document/email style (Outlook/Word). Use complete sentences, formal tone.",
        "code" => "code/terminal style. Keep exactly as is, do not add punctuation.",
        "notes" => "notes style (Notion/Obsidian). Clear, organized prose.",
        _ => "clean, natural dictation style.",
    };

    let style = if style_note.is_empty() {
        "".to_string()
    } else {
        format!("Additional style constraint: {}\n", style_note)
    };

    format!(
        r#"You are an expert voice dictation post-processor.
Task: Clean up the raw voice transcript to make it clean, natural, and readable.
Target App Context: {context_hint}
{style}
Rules:
- Remove filler words (um, uh, you know, i mean, etc.) ONLY where they carry no meaning.
- NEVER delete a word that is doing real work. "right" in "right now" or "that's right", "like" in "I like it", "so" in "so that it works", "well" in "well done", "kind of" in "what kind of person" must all stay. When in doubt, keep the word.
- Resolve self-corrections (e.g., "went to the office no I mean the park" -> "went to the park")
- Treat "scratch that", "delete that", "cancel that", and "ignore that" as editing commands: remove the preceding clause and the command itself without leaving stray punctuation.
- Fix capitalization and basic punctuation.
- End each sentence with the punctuation that actually fits it. Questions end with "?" and exclamations with "!". Never append a full stop after a "?" or "!", and never turn a question into a statement.
- Do NOT put a full stop at the very end of the output. Full stops BETWEEN sentences are required; the last sentence just ends. A final "?" or "!" is kept.
- Output ONLY the final cleaned text. Do NOT include preambles, explanations, or quotes.

Examples:
Input: "so um, yesterday i went to the office no i mean i went to the park and like it was raining uh you know"
Output: "Yesterday I went to the park and it was raining"

Input: "first we need to buy milk wait no water and then bread"
Output: "First we need to buy water and then bread"

Input: "hey mahesh lets meet at 6pm no actually at 8pm"
Output: "Hey Mahesh, let's meet at 8pm"

Input: "send it to bob sorry to jim"
Output: "Send it to Jim"

Input: "Let's not meet tomorrow. Cancel that. Let's meet today."
Output: "Let's meet today"

Input: "um ok right now i'm heading out"
Output: "OK, right now I'm heading out"

Input: "so are you coming to the meeting question mark"
Output: "Are you coming to the meeting?"

Input: "the build is green i pushed it already lets ship in the morning"
Output: "The build is green. I pushed it already. Let's ship in the morning"

Input: "{raw_text}"
Output: "#,
        context_hint = context_hint,
        style = style,
        raw_text = raw_text,
    )
}

use tauri::{AppHandle, Manager};

/// Main cleanup command — uses LLM if enabled, otherwise falls back to regex
#[tauri::command]
pub fn cleanup_text(app: AppHandle, raw_text: String, app_exe: String) -> Result<String, String> {
    let llm_enabled = {
        if let Some(db_state) = app.try_state::<crate::db::DbState>() {
            let conn = db_state.0.lock().unwrap();
            let val: Result<String, _> = conn.query_row(
                "SELECT value FROM settings WHERE key = 'llm_enabled'",
                [],
                |row| row.get(0),
            );
            val.unwrap_or_else(|_| "false".to_string()) == "true"
        } else {
            false
        }
    };

    if llm_enabled && crate::llm::is_llama_cli_installed(app.clone()) {
        let system_prompt = {
            if let Some(db_state) = app.try_state::<crate::db::DbState>() {
                let conn = db_state.0.lock().unwrap();
                let val: Result<String, _> = conn.query_row(
                    "SELECT value FROM settings WHERE key = 'llm_system_prompt'",
                    [],
                    |row| row.get(0),
                );
                val.unwrap_or_else(|_| "".to_string())
            } else {
                "".to_string()
            }
        };

        let prompt = build_cleanup_prompt(&raw_text, &app_exe, &system_prompt);
        match crate::llm::run_inference(&app, &prompt) {
            Ok(result) => return Ok(finalize_dictation(&result)),
            Err(e) => {
                eprintln!("LLM Cleanup failed: {}. Falling back to regex.", e);
            }
        }
    }

    let cleaned = regex_cleanup(&raw_text);
    Ok(finalize_dictation(&cleaned))
}

/// Command mode: transform selected text with an instruction
#[tauri::command]
pub fn command_mode_transform(
    app: AppHandle,
    selected_text: String,
    instruction: String,
    app_exe: String,
) -> Result<String, String> {
    let llm_enabled = {
        if let Some(db_state) = app.try_state::<crate::db::DbState>() {
            let conn = db_state.0.lock().unwrap();
            let val: Result<String, _> = conn.query_row(
                "SELECT value FROM settings WHERE key = 'llm_enabled'",
                [],
                |row| row.get(0),
            );
            val.unwrap_or_else(|_| "false".to_string()) == "true"
        } else {
            false
        }
    };

    if llm_enabled && crate::llm::is_llama_cli_installed(app.clone()) {
        let context = app_context(&app_exe);
        let prompt = format!(
            r#"You are a text transformation engine.
Task: Modify the original text according to the instructions.
Target App Context: {context} (Application: {app_exe})
Instructions: {instruction}
Respond ONLY with the final modified text — no preamble, no explanations, no wrapping quotes.

Original text:
"""
{selected_text}
"""

Modified text:
"""#,
            context = context,
            app_exe = app_exe,
            instruction = instruction,
            selected_text = selected_text
        );

        match crate::llm::run_inference(&app, &prompt) {
            Ok(result) => return Ok(trim_surrounding_quotes(&result)),
            Err(e) => {
                eprintln!(
                    "LLM Command mode transform failed: {}. Falling back to regex rules.",
                    e
                );
            }
        }
    }

    // Without LLM, do basic transformations based on common instructions
    let lower_instruction = instruction.to_lowercase();

    let result = if lower_instruction.contains("bullet") || lower_instruction.contains("list") {
        // Convert to bullet points
        selected_text
            .split(". ")
            .filter(|s| !s.is_empty())
            .map(|s| format!("• {}", s.trim()))
            .collect::<Vec<_>>()
            .join("\n")
    } else if lower_instruction.contains("concis") || lower_instruction.contains("shorter") {
        // Shorten: keep first sentence of each paragraph
        selected_text
            .split('\n')
            .map(|para| para.split(". ").next().unwrap_or(para).to_string())
            .collect::<Vec<_>>()
            .join("\n")
    } else if lower_instruction.contains("formal") || lower_instruction.contains("professional") {
        // Basic formality
        regex_cleanup(&selected_text)
    } else if lower_instruction.contains("uppercase") || lower_instruction.contains("caps") {
        selected_text.to_uppercase()
    } else if lower_instruction.contains("lowercase") {
        selected_text.to_lowercase()
    } else {
        // Default: just clean it up
        regex_cleanup(&selected_text)
    };

    Ok(trim_surrounding_quotes(&result))
}

/// Strip wrapping that small/weak LLMs add around their answer despite being told not
/// to: Markdown code fences (```), stray backticks, and surrounding quotes.
pub fn trim_surrounding_quotes(text: &str) -> String {
    let mut s = text.trim().to_string();

    // Markdown code fence, e.g. "```\nclean text\n```" or "```text\n...\n```".
    if s.starts_with("```") {
        // Drop the opening fence (``` plus an optional language tag, up to the newline).
        match s.find('\n') {
            Some(nl) => s = s[nl + 1..].to_string(),
            None => s = s.trim_start_matches('`').to_string(),
        }
        // Drop a trailing closing fence.
        let end = s.trim_end();
        if let Some(stripped) = end.strip_suffix("```") {
            s = stripped.to_string();
        }
        s = s.trim().to_string();
    }

    // Stray backticks at the very edges (inline-code style wrapping).
    s = s.trim().trim_matches('`').trim().to_string();

    // Surrounding matching quotes.
    if (s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')) {
        if s.len() >= 2 {
            s = s[1..s.len() - 1].trim().to_string();
        }
    }

    s
}

#[cfg(test)]
mod tests {
    use super::{
        apply_spoken_commands, finalize_dictation, regex_cleanup, resolve_corrections,
        strip_fillers,
    };

    #[test]
    fn correction_no_actually_keeps_second_connector() {
        assert_eq!(
            resolve_corrections("hey mahesh lets meet at 6pm no actually at 8 pm"),
            "hey mahesh lets meet at 8 pm"
        );
    }

    #[test]
    fn correction_no_wait_keeps_second_connector() {
        assert_eq!(
            resolve_corrections("hey mahesh lets meet at 6pm no wait at 8 pm"),
            "hey mahesh lets meet at 8 pm"
        );
    }

    #[test]
    fn correction_i_mean_with_dash_keeps_first_connector() {
        assert_eq!(
            resolve_corrections("let's meet at 6pm \u{2014} I mean 8pm"),
            "let's meet at 8pm"
        );
    }

    #[test]
    fn correction_comma_sorry_comma() {
        assert_eq!(
            resolve_corrections("let's meet at 6, sorry, 8"),
            "let's meet at 8"
        );
    }

    #[test]
    fn correction_does_not_touch_ordinary_no() {
        // "no" without a leading delimiter and not part of a compound cue is left alone.
        assert_eq!(resolve_corrections("i said no to him"), "i said no to him");
        assert_eq!(
            resolve_corrections("i'm sorry about that"),
            "i'm sorry about that"
        );
    }

    #[test]
    fn correction_preserves_the_verb() {
        // The wrong value must not swallow "meet".
        assert_eq!(
            resolve_corrections("send it to bob sorry, to jim"),
            "send it to jim"
        );
    }

    #[test]
    fn inserts_comma_and_period() {
        assert_eq!(
            apply_spoken_commands("hello comma world period"),
            "Hello, world."
        );
    }

    #[test]
    fn new_line_and_paragraph() {
        assert_eq!(
            apply_spoken_commands("line one new line line two"),
            "Line one\nLine two"
        );
        assert_eq!(
            apply_spoken_commands("intro new paragraph body"),
            "Intro\n\nBody"
        );
    }

    #[test]
    fn scratch_that_drops_previous_clause() {
        assert_eq!(
            apply_spoken_commands("let's meet at five. scratch that let's meet at six"),
            "Let's meet at six"
        );
    }

    #[test]
    fn cancel_that_drops_its_own_period() {
        assert_eq!(
            apply_spoken_commands("Let's not meet tomorrow. Cancel that. Let's meet today."),
            "Let's meet today."
        );
    }

    #[test]
    fn fallback_cleanup_handles_cancel_that_end_to_end() {
        let cleaned = regex_cleanup("Let's not meet tomorrow. Cancel that. Let's meet today.");
        assert_eq!(finalize_dictation(&cleaned), "Let's meet today");
    }

    #[test]
    fn delete_that_does_not_double_the_previous_sentence_period() {
        assert_eq!(
            apply_spoken_commands(
                "The first plan is approved. The second plan is wrong. Delete that. Use the third plan."
            ),
            "The first plan is approved. Use the third plan."
        );
    }

    #[test]
    fn cancel_that_drops_command_commas() {
        assert_eq!(
            apply_spoken_commands("buy milk, cancel that, buy eggs"),
            "Buy eggs"
        );
    }

    #[test]
    fn command_at_the_end_leaves_no_orphan_punctuation() {
        assert_eq!(
            apply_spoken_commands("Keep this sentence. Remove this one. Ignore that."),
            "Keep this sentence."
        );
        assert_eq!(apply_spoken_commands("Cancel that."), "");
    }

    #[test]
    fn finalizer_removes_llm_leading_orphan_punctuation() {
        assert_eq!(
            finalize_dictation(". Let's meet today."),
            "Let's meet today"
        );
        assert_eq!(finalize_dictation("!important"), "!important");
    }

    #[test]
    fn capitalization_does_not_break_punctuation_inside_tokens() {
        assert_eq!(
            apply_spoken_commands("visit example.com and use !important"),
            "Visit example.com and use !important"
        );
        assert_eq!(
            apply_spoken_commands("first sentence. second sentence"),
            "First sentence. Second sentence"
        );
    }

    #[test]
    fn question_and_exclamation() {
        assert_eq!(
            apply_spoken_commands("are you sure question mark"),
            "Are you sure?"
        );
        assert_eq!(
            apply_spoken_commands("watch out exclamation point"),
            "Watch out!"
        );
    }

    // ── Spoken notation: symbols and operators ────────────────────────────

    #[test]
    fn bare_operators_convert_between_operands() {
        assert_eq!(apply_spoken_commands("set x equals 50"), "Set x = 50");
        assert_eq!(apply_spoken_commands("2 plus 2 equals 4"), "2 + 2 = 4");
        assert_eq!(apply_spoken_commands("n minus 1"), "N - 1");
        assert_eq!(apply_spoken_commands("10 divided by 2"), "10 / 2");
        assert_eq!(apply_spoken_commands("x greater than 5"), "X > 5");
        assert_eq!(
            apply_spoken_commands("n greater than or equal to 3"),
            "N >= 3"
        );
        assert_eq!(apply_spoken_commands("2 to the power of 8"), "2 ^ 8");
        // A sentence-ending period must not be captured as part of the operand.
        assert_eq!(
            apply_spoken_commands("x equals 50, y equals 40, z equals 80."),
            "X = 50, y = 40, z = 80."
        );
    }

    #[test]
    fn a_chain_of_operators_resolves_fully() {
        // Each match consumes its right operand, so this only works if the pass repeats.
        assert_eq!(apply_spoken_commands("1 plus 2 plus 3 plus 4"), "1 + 2 + 3 + 4");
    }

    #[test]
    fn bare_operators_leave_ordinary_english_alone() {
        // These are the words real dictation actually contains — converting them on
        // sight would break far more text than it fixed.
        for prose in [
            "This equals a win",
            "Three times faster than before",
            "It was less than ideal",
            "Plus, we shipped it on time",
            "The percent of users who stayed",
        ] {
            assert_eq!(apply_spoken_commands(prose), prose, "mangled: {prose}");
        }
    }

    #[test]
    fn a_and_i_are_never_operands() {
        // The worst false positive available: "a" is a letter, but "5 times a day" is
        // English, not multiplication.
        assert_eq!(apply_spoken_commands("5 times a day"), "5 times a day");
        assert_eq!(apply_spoken_commands("2 plus a bit"), "2 plus a bit");
    }

    #[test]
    fn named_symbols_convert_anywhere() {
        assert_eq!(apply_spoken_commands("use asterisk here"), "Use * here");
        assert_eq!(apply_spoken_commands("Tom ampersand Jerry"), "Tom & Jerry");
        assert_eq!(apply_spoken_commands("it costs dollar sign 50"), "It costs $50");
        assert_eq!(apply_spoken_commands("margin is 20 percent sign"), "Margin is 20%");
        assert_eq!(apply_spoken_commands("x equals sign 50"), "X = 50");
        assert_eq!(apply_spoken_commands("5 plus or minus 2"), "5 ± 2");
    }

    #[test]
    fn number_before_percent_becomes_a_sign() {
        assert_eq!(apply_spoken_commands("up 50 percent today"), "Up 50% today");
    }

    #[test]
    fn brackets_and_quotes_hug_their_contents() {
        assert_eq!(apply_spoken_commands("done open paren mostly close paren"), "Done (mostly)");
        assert_eq!(
            apply_spoken_commands("arr open square bracket 0 close square bracket"),
            "Arr [0]"
        );
        assert_eq!(apply_spoken_commands("open quote hi close quote"), "\"Hi\"");
    }

    #[test]
    fn identifier_symbols_hug_both_sides() {
        assert_eq!(apply_spoken_commands("my underscore var"), "My_var");
        assert_eq!(
            apply_spoken_commands("email john at sign example.com"),
            "Email john@example.com"
        );
    }

    #[test]
    fn whisper_mishearing_of_exclamation_still_works() {
        // Whisper reliably returns "explanation mark" for "exclamation mark".
        assert_eq!(apply_spoken_commands("watch out explanation mark"), "Watch out!");
        assert_eq!(apply_spoken_commands("watch out exclamation mark"), "Watch out!");
    }

    #[test]
    fn notation_does_not_swallow_a_spoken_new_line() {
        assert_eq!(
            apply_spoken_commands("x equals 50 new line y equals 60"),
            "X = 50\nY = 60"
        );
    }

    #[test]
    fn semicolon_not_eaten_by_colon() {
        assert_eq!(
            apply_spoken_commands("first semicolon second colon third"),
            "First; second: third"
        );
    }

    #[test]
    fn trailing_new_line_with_auto_period_is_not_orphaned() {
        // regex_cleanup auto-appends a "." which can land after a trailing newline.
        assert_eq!(apply_spoken_commands("done new line."), "Done");
    }

    // ── Filler removal keeps meaningful words ──────────────────────────────

    #[test]
    fn keeps_words_that_are_doing_real_work() {
        // The reported bug: "ok right now" collapsed to "now".
        assert_eq!(strip_fillers("ok right now"), "ok right now");
        assert_eq!(
            strip_fillers("turn right at the light"),
            "turn right at the light"
        );
        assert_eq!(strip_fillers("that's right"), "that's right");
        assert_eq!(strip_fillers("I like this song"), "I like this song");
        assert_eq!(
            strip_fillers("size it so that it fits"),
            "size it so that it fits"
        );
        assert_eq!(strip_fillers("well done everyone"), "well done everyone");
        assert_eq!(
            strip_fillers("what kind of person says that"),
            "what kind of person says that"
        );
        assert_eq!(
            strip_fillers("do you know the answer"),
            "do you know the answer"
        );
    }

    #[test]
    fn drops_actual_fillers() {
        assert_eq!(strip_fillers("um yeah"), "yeah");
        assert_eq!(strip_fillers("So, we shipped it"), "we shipped it");
        assert_eq!(
            strip_fillers("it was, honestly, terrible"),
            "it was, terrible"
        );
        assert_eq!(strip_fillers("it was kind of weird"), "it was weird");
        assert_eq!(
            strip_fillers("it broke again, you know."),
            "it broke again."
        );
    }

    // ── Terminal punctuation ───────────────────────────────────────────────

    #[test]
    fn spoken_question_mark_does_not_get_a_full_stop() {
        let cleaned = regex_cleanup("um are you coming to the meeting question mark");
        assert_eq!(
            finalize_dictation(&cleaned),
            "Are you coming to the meeting?"
        );
    }

    #[test]
    fn spoken_exclamation_does_not_get_a_full_stop() {
        let cleaned = regex_cleanup("watch out exclamation mark");
        assert_eq!(finalize_dictation(&cleaned), "Watch out!");
    }

    #[test]
    fn plain_statement_gets_no_trailing_full_stop() {
        let cleaned = regex_cleanup("we ship on monday");
        assert_eq!(finalize_dictation(&cleaned), "We ship on monday");
    }

    #[test]
    fn trailing_full_stop_is_removed_from_a_finished_sentence() {
        assert_eq!(
            finalize_dictation("We ship on monday."),
            "We ship on monday"
        );
    }

    #[test]
    fn periods_between_sentences_survive() {
        assert_eq!(
            finalize_dictation("The build is green. I pushed it already."),
            "The build is green. I pushed it already"
        );
    }

    #[test]
    fn a_spoken_full_stop_at_the_end_is_honoured() {
        assert_eq!(
            finalize_dictation("we ship on monday period"),
            "We ship on monday."
        );
        assert_eq!(
            finalize_dictation("we ship on monday full stop"),
            "We ship on monday."
        );
        // Only the ENDING one counts — a mid-sentence "period" leaves the tail bare.
        assert_eq!(
            finalize_dictation("we ship on monday period then we rest"),
            "We ship on monday. Then we rest"
        );
    }

    #[test]
    fn stronger_terminators_and_tokens_are_left_alone() {
        assert_eq!(finalize_dictation("Are you sure?"), "Are you sure?");
        assert_eq!(finalize_dictation("Stop!"), "Stop!");
        assert_eq!(finalize_dictation("Are you sure?."), "Are you sure?");
        assert_eq!(finalize_dictation("He said \"hi!\""), "He said \"hi!\"");
        // An ellipsis is deliberate; taking one dot off it would look broken.
        assert_eq!(
            finalize_dictation("well I guess so..."),
            "Well I guess so..."
        );
        // A period inside the last token is not a sentence ending.
        assert_eq!(finalize_dictation("go to example.com"), "Go to example.com");
    }

    #[test]
    fn plain_text_untouched() {
        assert_eq!(
            apply_spoken_commands("Just a normal sentence."),
            "Just a normal sentence."
        );
    }
}
