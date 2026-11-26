/// snippets.rs — voice snippets (Formatting options → Voice snippets).
///
/// Say a phrase, get saved text: "my email" → "arya@example.com". Stored in the
/// `snippets` setting as JSON: [{"trigger": "my email", "text": "..."}].
///
/// - The whole dictation is the phrase ("My email.") → just the saved text, no full stop.
/// - The phrase inside a sentence ("send it to my email please") → replaced in place,
///   for phrases of two words or more.
/// - A one-word snippet ("email") fires when it's all you said, or mid-sentence after
///   "my" ("here is my email" → "here is me@…"). Never on its own mid-sentence, or
///   "I'll send you an email" would turn into the address.
/// Matching ignores case, and commas or extra spaces between the phrase's words.
use regex::Regex;
use serde::Deserialize;

#[derive(Deserialize, Clone, Debug)]
pub struct Snippet {
    pub trigger: String,
    pub text: String,
}

pub fn load(conn: &rusqlite::Connection) -> Vec<Snippet> {
    conn.query_row("SELECT value FROM settings WHERE key = 'snippets'", [], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|v| serde_json::from_str::<Vec<Snippet>>(&v).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|s| !s.trigger.trim().is_empty() && !s.text.is_empty())
        .collect()
}

fn words(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
        .collect()
}

pub fn expand(text: &str, snippets: &[Snippet]) -> String {
    if snippets.is_empty() {
        return text.to_string();
    }
    // Longest phrases first, so "my work email" wins over "my email".
    let mut list: Vec<&Snippet> = snippets.iter().collect();
    list.sort_by_key(|s| std::cmp::Reverse(words(&s.trigger).len()));

    let said = words(text);
    for s in &list {
        if words(&s.trigger) == said {
            return s.text.clone();
        }
    }

    let mut out = text.to_string();
    for s in &list {
        let w = words(&s.trigger);
        let phrase = w.iter().map(|x| regex::escape(x)).collect::<Vec<_>>().join(r"[\s,]+");
        // One word: only as "my <word>" (the "my" is replaced too, unless the trigger
        // already starts with it).
        let pattern = if w.len() < 2 {
            if w.first().map_or(true, |x| x == "my") {
                continue;
            }
            format!(r"(?i)\bmy[\s,]+{phrase}\b")
        } else {
            format!(r"(?i)\b{phrase}\b")
        };
        if let Ok(re) = Regex::new(&pattern) {
            out = re.replace_all(&out, regex::NoExpand(&s.text)).into_owned();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sn(t: &str, x: &str) -> Snippet {
        Snippet { trigger: t.into(), text: x.into() }
    }

    #[test]
    fn whole_dictation_becomes_the_text() {
        let s = [sn("my email", "me@example.com")];
        assert_eq!(expand("My email.", &s), "me@example.com");
        assert_eq!(expand("my, email", &s), "me@example.com");
    }

    #[test]
    fn phrase_inside_a_sentence_is_replaced() {
        let s = [sn("my email", "me@example.com")];
        assert_eq!(expand("Send it to my email please.", &s), "Send it to me@example.com please.");
    }

    #[test]
    fn longer_phrase_wins_and_others_untouched() {
        let s = [sn("my email", "a@x.com"), sn("my work email", "b@work.com")];
        assert_eq!(expand("Use my work email.", &s), "Use b@work.com.");
        assert_eq!(expand("Nothing here.", &s), "Nothing here.");
        assert_eq!(expand("Myemailing list.", &s), "Myemailing list.");
    }

    #[test]
    fn dollar_signs_in_text_are_kept() {
        let s = [sn("the price", "$5 off")];
        assert_eq!(expand("It's the price today", &s), "It's $5 off today");
    }

    #[test]
    fn one_word_snippet_only_when_said_alone() {
        let s = [sn("Email", "me@example.com")];
        assert_eq!(expand("Email.", &s), "me@example.com");
        assert_eq!(expand("I'll send you an email.", &s), "I'll send you an email.");
    }

    #[test]
    fn one_word_snippet_after_my() {
        let s = [sn("Email", "me@example.com")];
        assert_eq!(expand("Okay, here is my email.", &s), "Okay, here is me@example.com.");
        assert_eq!(expand("My email is below", &s), "me@example.com is below");
        assert_eq!(expand("Check your email.", &s), "Check your email.");
    }
}
