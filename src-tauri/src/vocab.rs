/// vocab.rs — the user's dictionary: names, jargon and product words the app should
/// always spell right.
///
/// Each entry is a term (the correct spelling, e.g. "kubectl") plus optional "sounds
/// like" spellings a transcript may show instead ("cube control, cube cuddle"). The
/// list reaches every stage of a dictation:
///
/// 1. **Whisper** gets the terms as its context prompt (`whisper_prompt`), which biases
///    recognition toward those spellings.
/// 2. **Exact fixes**: any "sounds like" spelling in the transcript is swapped for its
///    term (`apply`). Deterministic, so it works with cleanup off too: the user wrote
///    the rule. Case-only fixes ("localflow" -> "LocalFlow") apply to terms with
///    unusual casing, never to ordinary capitalised words.
/// 3. **AI cleanup** sees the list and the spellings (`llm_lines`), so it can fix
///    near-misses the exact pass can't.
///
/// Whisper sometimes answers silence or noise by repeating its prompt back; a
/// transcript made only of dictionary terms is treated as no speech (`only_repeats_prompt`).
///
/// Design follows Hex's vocabulary (anomalyco/hex docs/features/vocabulary.md): one
/// list, term + sounds-like, prompt bounded by characters, exact-spelling pass.
use once_cell::sync::Lazy;
use regex::Regex;
use rusqlite::Connection;

/// Whisper's prompt slot holds ~223 tokens; 500 characters stays safely inside it.
const PROMPT_BUDGET: usize = 500;
/// Spellings shorter than this (after dropping spaces/punctuation) would match too much.
const MIN_SPELLING: usize = 2;

#[derive(Debug, Clone, PartialEq)]
pub struct Term {
    pub term: String,
    pub sounds_like: Vec<String>,
}

/// Split the stored "sounds like" field ("a, b; c") into clean spellings.
pub fn split_spellings(field: &str) -> Vec<String> {
    field
        .split(|c| c == ',' || c == ';' || c == '\n')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Every dictionary entry, oldest first (the order the user added them, so the
/// first words they cared about win the prompt budget).
pub fn load(conn: &Connection) -> Vec<Term> {
    let mut stmt = match conn
        .prepare("SELECT term, pronunciation FROM dictionary ORDER BY created_at ASC, id ASC")
    {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    stmt.query_map([], |row| {
        let term: String = row.get(0)?;
        let spell: String = row.get(1)?;
        Ok(Term {
            term: term.trim().to_string(),
            sounds_like: split_spellings(&spell),
        })
    })
    .map(|rows| rows.filter_map(|r| r.ok()).filter(|t| !t.term.is_empty()).collect())
    .unwrap_or_default()
}

pub fn load_from_app(app: &tauri::AppHandle) -> Vec<Term> {
    use tauri::Manager;
    match app.try_state::<crate::db::DbState>() {
        Some(db) => load(&db.0.lock().unwrap()),
        None => Vec::new(),
    }
}

/// "Term, Term, …" for Whisper's context prompt, as many terms as fit the budget.
pub fn whisper_prompt(terms: &[Term]) -> String {
    let mut out = String::new();
    for t in terms {
        let piece = if out.is_empty() { t.term.clone() } else { format!(", {}", t.term) };
        if out.len() + piece.len() + 1 > PROMPT_BUDGET {
            break;
        }
        out.push_str(&piece);
    }
    if out.is_empty() {
        out
    } else {
        out.push('.');
        out
    }
}

fn letters_len(s: &str) -> usize {
    s.chars().filter(|c| c.is_alphanumeric()).count()
}

/// A term whose casing carries meaning (LocalFlow, iOS, kubectl, GPT-4), so a
/// transcript's "localflow" / "Ios" is worth correcting. Plain words ("Rune",
/// "rune") are left alone: they may be ordinary words in the sentence.
fn has_meaningful_case(term: &str) -> bool {
    let mut chars = term.chars();
    let first = match chars.next() {
        Some(c) => c,
        None => return false,
    };
    let rest: String = chars.collect();
    let inner_upper = rest.chars().any(|c| c.is_uppercase());
    let lower_lead_with_upper = first.is_lowercase() && inner_upper;
    let has_digit = term.chars().any(|c| c.is_ascii_digit());
    inner_upper || lower_lead_with_upper || (has_digit && term.chars().any(|c| c.is_alphabetic()))
}

fn pattern_for(spelling: &str) -> Option<Regex> {
    let esc = regex::escape(spelling);
    // Spaces in a spelling match any run of whitespace or a hyphen ("cube control",
    // "cube-control").
    let esc = esc.replace(r"\ ", r"[\s\-]+").replace(' ', r"[\s\-]+");
    let lead = if spelling.chars().next().map_or(false, |c| c.is_alphanumeric()) { r"\b" } else { "" };
    let tail = if spelling.chars().last().map_or(false, |c| c.is_alphanumeric()) { r"\b" } else { "" };
    Regex::new(&format!(r"(?i){lead}{esc}{tail}")).ok()
}

/// Swap every "sounds like" spelling (and case-only variants of terms with meaningful
/// casing) for the term. Longest spelling first, so "cube control" wins over "cube".
pub fn apply(text: &str, terms: &[Term]) -> String {
    if terms.is_empty() || text.is_empty() {
        return text.to_string();
    }
    let mut rules: Vec<(String, &str)> = Vec::new();
    for t in terms {
        for s in &t.sounds_like {
            if letters_len(s) >= MIN_SPELLING && !s.eq_ignore_ascii_case(&t.term) {
                rules.push((s.clone(), t.term.as_str()));
            }
        }
        if has_meaningful_case(&t.term) && letters_len(&t.term) >= MIN_SPELLING {
            rules.push((t.term.clone(), t.term.as_str()));
        }
    }
    rules.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    let mut out = text.to_string();
    for (spelling, term) in rules {
        if let Some(re) = pattern_for(&spelling) {
            out = re.replace_all(&out, regex::NoExpand(term)).into_owned();
        }
    }
    out
}

static WORDISH: Lazy<Regex> = Lazy::new(|| Regex::new(r"[^\p{L}\p{N}]+").unwrap());

fn norm(s: &str) -> String {
    WORDISH.replace_all(&s.to_lowercase(), " ").trim().to_string()
}

/// True when the transcript is nothing but dictionary terms (two or more), the shape of
/// Whisper echoing its prompt on silence or noise.
pub fn only_repeats_prompt(text: &str, terms: &[Term]) -> bool {
    if terms.len() < 2 {
        return false;
    }
    let mut rest = format!(" {} ", norm(text));
    if rest.trim().is_empty() {
        return false;
    }
    let mut keys: Vec<String> = terms.iter().map(|t| norm(&t.term)).filter(|k| !k.is_empty()).collect();
    keys.sort_by(|a, b| b.len().cmp(&a.len()));
    let mut hits = 0;
    for k in &keys {
        let needle = format!(" {} ", k);
        while let Some(i) = rest.find(&needle) {
            rest.replace_range(i..i + needle.len(), " ");
            hits += 1;
        }
    }
    hits >= 2 && rest.trim().is_empty()
}

/// The vocabulary block for the AI cleanup prompt; empty when there are no terms.
pub fn llm_lines(terms: &[Term]) -> String {
    if terms.is_empty() {
        return String::new();
    }
    let items: Vec<String> = terms
        .iter()
        .take(80)
        .map(|t| {
            if t.sounds_like.is_empty() {
                t.term.clone()
            } else {
                format!("{} (may be transcribed as {})", t.term, t.sounds_like.join(", "))
            }
        })
        .collect();
    format!(
        "Vocabulary (spell these exactly when the speaker means them, including near-misses that sound alike): {}\n",
        items.join("; ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(term: &str, s: &[&str]) -> Term {
        Term { term: term.into(), sounds_like: s.iter().map(|x| x.to_string()).collect() }
    }

    #[test]
    fn swaps_sounds_like_spellings_longest_first() {
        let terms = vec![t("kubectl", &["cube control", "cube"]), t("Arya", &["aria"])];
        assert_eq!(apply("run cube control get pods, aria", &terms), "run kubectl get pods, Arya");
        assert_eq!(apply("Cube-Control apply", &terms), "kubectl apply");
        // whole words only
        assert_eq!(apply("cubes and arias", &terms), "cubes and arias");
    }

    #[test]
    fn fixes_case_only_for_terms_with_meaningful_casing() {
        let terms = vec![t("LocalFlow", &[]), t("iOS", &[]), t("Rune", &[])];
        assert_eq!(apply("open localflow on ios", &terms), "open LocalFlow on iOS");
        assert_eq!(apply("a rune stone", &terms), "a rune stone");
    }

    #[test]
    fn ignores_one_letter_spellings() {
        let terms = vec![t("Xcode", &["x"])];
        assert_eq!(apply("x marks the spot", &terms), "x marks the spot");
    }

    #[test]
    fn prompt_is_a_bounded_term_list() {
        let terms = vec![t("LocalFlow", &["local flow"]), t("Tauri", &[])];
        assert_eq!(whisper_prompt(&terms), "LocalFlow, Tauri.");
        let many: Vec<Term> = (0..200).map(|i| t(&format!("Term{i}"), &[])).collect();
        assert!(whisper_prompt(&many).len() <= PROMPT_BUDGET);
        assert_eq!(whisper_prompt(&[]), "");
    }

    #[test]
    fn detects_prompt_echo() {
        let terms = vec![t("LocalFlow", &[]), t("Tauri", &[]), t("Whisper", &[])];
        assert!(only_repeats_prompt("LocalFlow, Tauri.", &terms));
        assert!(!only_repeats_prompt("I opened LocalFlow and Tauri", &terms));
        assert!(!only_repeats_prompt("LocalFlow", &terms));
    }

    #[test]
    fn llm_block_lists_terms_and_spellings() {
        let terms = vec![t("kubectl", &["cube control"]), t("Arya", &[])];
        let s = llm_lines(&terms);
        assert!(s.contains("kubectl (may be transcribed as cube control); Arya"));
        assert_eq!(llm_lines(&[]), "");
    }
}
