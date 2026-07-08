use once_cell::sync::Lazy;
/// cleanup.rs — AI text cleanup using regex fallback
/// The LLM (llama.cpp) path is wired but falls back to regex if model not loaded.
/// This satisfies the requirement for graceful degradation.
use regex::Regex;

// Filler words to strip
static FILLER_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(um+|uh+|like|you know|sort of|kind of|i mean|well|so|right|okay|actually|basically|literally|honestly|seriously|you see|i guess|i think|i feel like|to be honest|to tell you the truth|at the end of the day)\b[,.]?\s*"
    ).unwrap()
});

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
    caps.name("c1").map(|m| m.as_str()).unwrap_or("").to_string()
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
    text = FILLER_RE.replace_all(&text, " ").to_string();

    // Basic sentence casing
    text = sentence_case(&text);

    // Clean up extra spaces
    text = text.split_whitespace().collect::<Vec<_>>().join(" ");

    // Ensure sentence ends with punctuation
    let text = text.trim().to_string();
    if !text.is_empty() && !text.ends_with(['.', '!', '?', ',', ';', ':']) {
        format!("{}.", text)
    } else {
        text
    }
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
        (p(r"(?i)\s*\bexclamation\s+(?:mark|point)\b"), "!"),
        (p(r"(?i)\s*\b(?:full\s+stop|full-stop)\b"), "."),
        (p(r"(?i)\s*\bsemi[\s-]?colon\b"), ";"),
        (p(r"(?i)\s*\bcomma\b"), ","),
        (p(r"(?i)\s*\bperiod\b"), "."),
        (p(r"(?i)\s*\bcolon\b"), ":"),
    ]
});

// Tidy passes run after substitution.
static SPACE_BEFORE_PUNCT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[ \t]+([,.;:!?])").unwrap());
static MULTISPACE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[ \t]{2,}").unwrap());
static AROUND_NL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[ \t]*\n[ \t]*").unwrap());
static MULTI_NL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\n{3,}").unwrap());
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
        let after = text[end..].to_string();
        text.truncate(boundary);
        text.push_str(&after);
    }

    // 2. Punctuation + line-break words → characters.
    for (re, rep) in SPOKEN_SUBS.iter() {
        text = re.replace_all(&text, *rep).to_string();
    }

    // 3. Tidy spacing without clobbering intentional newlines.
    text = SPACE_BEFORE_PUNCT_RE.replace_all(&text, "$1").to_string();
    text = MULTISPACE_RE.replace_all(&text, " ").to_string();
    text = AROUND_NL_RE.replace_all(&text, "\n").to_string();
    text = MULTI_NL_RE.replace_all(&text, "\n\n").to_string();
    text = text.trim().to_string();
    text = TAIL_ORPHAN_RE.replace(&text, "").trim_end().to_string();

    // 4. Re-capitalize sentence starts and the first word of each new line.
    recapitalize(&text)
}

/// Capitalize the first letter and the first letter after each `.`/`!`/`?`/newline.
fn recapitalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cap_next = true;
    for ch in text.chars() {
        if cap_next && ch.is_alphabetic() {
            out.extend(ch.to_uppercase());
            cap_next = false;
        } else {
            out.push(ch);
            if matches!(ch, '.' | '!' | '?' | '\n') {
                cap_next = true;
            } else if !ch.is_whitespace() {
                cap_next = false;
            }
            // whitespace between an ender and the next word leaves cap_next as-is
        }
    }
    out
}

/// Final post-processing applied to dictated text before injection: strip any LLM
/// wrapping, then resolve spoken commands.
fn finalize_dictation(text: &str) -> String {
    apply_spoken_commands(&trim_surrounding_quotes(text))
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
- Remove filler words (um, uh, like, you know, sort of, kind of, i mean, etc.)
- Resolve self-corrections (e.g., "went to the office no I mean the park" -> "went to the park")
- Fix capitalization and basic punctuation.
- Output ONLY the final cleaned text. Do NOT include preambles, explanations, or quotes.

Examples:
Input: "so um, yesterday i went to the office no i mean i went to the park and like it was raining uh you know"
Output: "Yesterday I went to the park and it was raining."

Input: "first we need to buy milk wait no water and then bread"
Output: "First we need to buy water and then bread."

Input: "hey mahesh lets meet at 6pm no actually at 8pm"
Output: "Hey Mahesh, let's meet at 8pm."

Input: "send it to bob sorry to jim"
Output: "Send it to Jim."

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
    use super::{apply_spoken_commands, resolve_corrections};

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
        assert_eq!(
            resolve_corrections("i said no to him"),
            "i said no to him"
        );
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

    #[test]
    fn plain_text_untouched() {
        assert_eq!(
            apply_spoken_commands("Just a normal sentence."),
            "Just a normal sentence."
        );
    }
}
