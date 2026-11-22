use futures_util::StreamExt;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

/// Matches subtitle-style non-speech tags Whisper emits on noise/silence:
/// `[BLANK_AUDIO]`, `(clicking)`, `(Upbeat music)`, `{music}`, `[ Applause ]`, etc.
static NON_SPEECH_TAG: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[\[\(\{][^\]\)\}]*[\]\)\}]").unwrap());

/// How long the loaded model stays resident after its last use before it is released.
///
/// This is a memory-vs-latency dial. The model is ~550 MB for large-v3-turbo, and it
/// used to be held for the life of the process — an idle LocalFlow sat on ~780 MB RSS
/// having done nothing since the last dictation. Dropping it the instant a dictation
/// finishes would give that back, but then *every* dictation pays the full load again,
/// which is the exact cost the cache exists to avoid.
///
/// So it is held for a window instead: dictate again within the window and the model is
/// still warm; walk away and the memory comes back. 90 s comfortably covers a burst of
/// back-to-back dictations while still releasing well before you'd notice.
///
/// Since the model is now loaded as soon as the mic opens (`preload`), a cold start is
/// mostly hidden behind your speaking time, so the window can be short.
pub const MODEL_IDLE_TTL: Duration = Duration::from_secs(30);

/// How often the reaper wakes to check. Coarse on purpose — this is a cleanup sweep,
/// not a deadline, and a sleeping thread that wakes twice a minute costs nothing.
pub const REAP_INTERVAL: Duration = Duration::from_secs(5);

struct CachedModel {
    path: String,
    ctx: Arc<WhisperContext>,
    /// Last time this model was handed out, or last seen in use by the reaper.
    last_used: Instant,
}

/// The loaded Whisper model, kept alive between nearby dictations and released once
/// `MODEL_IDLE_TTL` passes with no use.
///
/// Loading a model means reading the whole `.bin` off disk and building a context —
/// roughly half a gigabyte for the turbo model. That was happening on *every* dictation,
/// so each one paid the full load before a single word was transcribed. Caching it makes
/// a follow-up dictation start instantly; the idle TTL keeps that from costing half a
/// gigabyte of resident memory for the rest of the session.
///
/// Keyed by path: selecting a different model in the UI changes the path and reloads
/// naturally. `invalidate_model_cache` covers the cases a path can't catch, like
/// deleting and re-downloading the file that is currently active.
static MODEL_CACHE: Lazy<std::sync::Mutex<Option<CachedModel>>> =
    Lazy::new(|| std::sync::Mutex::new(None));

/// Starts the reaper exactly once, on the first model load. Doing it lazily rather than
/// at startup means a session that never dictates never spawns the thread.
static REAPER: std::sync::Once = std::sync::Once::new();

/// Release the model once it has gone `MODEL_IDLE_TTL` without being used.
///
/// A transcription in flight holds its own `Arc`, so a strong count above one means the
/// model is busy: that is treated as *use*, refreshing `last_used`. Without that, a
/// transcription longer than the TTL would end with an already-stale timestamp and the
/// next sweep would evict a model the user is still dictating into.
fn spawn_model_reaper() {
    REAPER.call_once(|| {
        std::thread::Builder::new()
            .name("whisper-model-reaper".into())
            .spawn(|| loop {
                std::thread::sleep(REAP_INTERVAL);
                // Never while the mic is open: that dictation is about to need it.
                if crate::audio::RECORDING.load(std::sync::atomic::Ordering::SeqCst) {
                    continue;
                }
                let mut cache = MODEL_CACHE
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let Some(cached) = cache.as_mut() else {
                    continue;
                };
                // Busy right now — keep it, and restart the idle clock from here.
                if Arc::strong_count(&cached.ctx) > 1 {
                    cached.last_used = Instant::now();
                    continue;
                }
                if cached.last_used.elapsed() >= MODEL_IDLE_TTL {
                    *cache = None;
                    drop(cache);
                    return_freed_memory();
                }
            })
            .ok();
    });
}

/// Load the speech model in the background as the mic opens, so transcription doesn't
/// wait for it when you stop. Whisper or Parakeet, whichever is active.
pub fn preload(model_path: String) {
    std::thread::Builder::new()
        .name("speech-model-preload".into())
        .spawn(move || {
            let started = Instant::now();
            let res = if crate::parakeet::is_parakeet(&model_path) {
                crate::parakeet::preload(&model_path)
            } else {
                crate::parakeet::unload();
                context_for(&model_path).map(|_| ())
            };
            match res {
                Ok(()) => eprintln!("speech model ready in {:?}", started.elapsed()),
                Err(e) => eprintln!("preload: {e}"),
            }
        })
        .ok();
}

/// Restart the idle clock (the mic just closed; transcription is next).
pub fn touch() {
    if let Ok(mut c) = MODEL_CACHE.try_lock() {
        if let Some(m) = c.as_mut() {
            m.last_used = Instant::now();
        }
    }
    crate::parakeet::touch();
}

/// Fetch the context for `model_path`, loading it only if it isn't already cached.
pub fn context_for(model_path: &str) -> Result<Arc<WhisperContext>, String> {
    spawn_model_reaper();

    let mut cache = MODEL_CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    if let Some(cached) = cache.as_mut() {
        if cached.path == model_path {
            cached.last_used = Instant::now();
            return Ok(cached.ctx.clone());
        }
    }

    // Drop the old model before loading the new one, so two never sit in memory at once.
    *cache = None;

    let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|e| format!("Failed to load the speech model: {}", e))?;
    let ctx = Arc::new(ctx);
    *cache = Some(CachedModel {
        path: model_path.to_string(),
        ctx: ctx.clone(),
        last_used: Instant::now(),
    });
    Ok(ctx)
}

/// Forget the cached model. Call after the active model file is deleted or replaced.
pub fn invalidate_model_cache() {
    *MODEL_CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

/// Hand freed memory back to macOS now. Without this the allocator keeps the pages it
/// got back from the model as a cache, and Activity Monitor keeps counting them
/// against LocalFlow (hundreds of MB) until the system happens to ask for them.
pub fn return_freed_memory() {
    #[cfg(target_os = "macos")]
    unsafe {
        extern "C" {
            fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize;
        }
        let freed = malloc_zone_pressure_relief(std::ptr::null_mut(), 0);
        eprintln!("memory: gave {} MB back to macOS", freed / (1024 * 1024));
    }
}

/// Whisper detects language from a single 30-second window, so only the opening of a
/// recording is worth analysing. Feeding it the whole take made a 10-minute dictation
/// compute 20× more mel spectrogram than the detector could ever look at.
const LANG_DETECT_SAMPLES: usize = 30 * crate::audio::SAMPLE_RATE as usize;

/// Decoder settings shared by every transcription path.
///
/// Both `transcribe` and the hotkey pipeline in `lib.rs` build their own `FullParams`;
/// they call this so the two can't drift apart. The values match whisper.cpp's current
/// defaults, but they are set explicitly so an upstream change can't silently turn them
/// off — a long dictation degenerating into the same sentence 47 times over is the
/// failure they exist to prevent.
///
///  • suppress_blank/nst — drop the subtitle-style artifacts Whisper learned from its
///                         caption training data ("[BLANK_AUDIO]", "(Upbeat music)").
///  • no_context         — never seed a 30 s window with the previous window's decoded
///                         text, so one bad decode can't feed itself forward.
///  • temperature + _inc — start greedy, then retry a window at rising temperature when
///                         the result looks degenerate. Without the increment there is no
///                         escape hatch once the decoder locks into a loop.
///  • entropy / logprob  — the "looks degenerate" test: low token entropy or a poor
///                         average log-probability triggers that retry.
pub fn apply_decoder_guards(params: &mut FullParams<'_, '_>) {
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    params.set_no_context(true);
    params.set_temperature(0.0);
    params.set_temperature_inc(0.2);
    params.set_entropy_thold(2.4);
    params.set_logprob_thold(-1.0);
    params.set_no_speech_thold(0.6);
}

/// Collapse runs of the same sentence repeated back to back.
///
/// Whisper's decoder can lock into a repetition loop on long recordings: it emits one
/// sentence over and over for the rest of the audio and never recovers. A real 3-minute
/// dictation in the wild came back as 56 sentences of which 47 were one unbroken run of
/// the same question — 64% of the transcript. The decoder guards in `transcribe` make
/// this rarer, but they cannot make it impossible, so this is the deterministic backstop.
///
/// Only *consecutive* exact duplicates collapse, because that is the shape a decoder loop
/// always takes. Deliberate repetition for emphasis is preserved: a short sentence has to
/// repeat at least three times before it is treated as a loop, so "No. No." survives while
/// "No. No. No. No." collapses.
pub fn collapse_repetitions(text: &str) -> String {
    // Split after ., ! or ? so each piece keeps its own terminator.
    let mut sentences: Vec<&str> = Vec::new();
    let mut start = 0;
    let bytes = text.as_bytes();
    for (i, ch) in text.char_indices() {
        if matches!(ch, '.' | '!' | '?') {
            let next = bytes.get(i + ch.len_utf8());
            if next.is_none() || next.is_some_and(|b| b.is_ascii_whitespace()) {
                sentences.push(&text[start..i + ch.len_utf8()]);
                start = i + ch.len_utf8();
            }
        }
    }
    if start < text.len() {
        sentences.push(&text[start..]);
    }

    /// Compare on lowercased words only, so spacing and trailing punctuation don't
    /// stop two identical sentences from matching.
    fn normalize(s: &str) -> String {
        s.split_whitespace()
            .map(|w| {
                w.trim_matches(|c: char| !c.is_alphanumeric())
                    .to_lowercase()
            })
            .filter(|w| !w.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }

    // Group consecutive sentences that normalize to the same thing.
    let mut out: Vec<&str> = Vec::with_capacity(sentences.len());
    let mut i = 0;
    while i < sentences.len() {
        let key = normalize(sentences[i]);
        let mut run = 1;
        while i + run < sentences.len() && normalize(sentences[i + run]) == key {
            run += 1;
        }

        let words = key.split_whitespace().count();
        // A substantial sentence repeating even twice is a loop; a short one needs a
        // longer run before we assume the user didn't mean it.
        let is_loop = run >= 2 && (words >= 4 || run >= 3);

        if is_loop {
            out.push(sentences[i]);
            eprintln!(
                "whisper: collapsed {} consecutive repeats of a {}-word sentence",
                run, words
            );
        } else {
            out.extend_from_slice(&sentences[i..i + run]);
        }
        i += run;
    }

    out.join("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Phrases Whisper invents on silence, breath or room noise. It learned them from
/// subtitle files, where quiet stretches are captioned "Thank you." or "Thanks for
/// watching!". Compared after lowercasing and dropping punctuation.
const STOCK_HALLUCINATIONS: &[&str] = &[
    "thank you",
    "thank you so much",
    "thank you very much",
    "thank you for watching",
    "thanks for watching",
    "thank you for listening",
    "thanks for listening",
    "thank you for watching and see you next time",
    "please subscribe",
    "subscribe to my channel",
    "like and subscribe",
    "see you next time",
    "see you in the next video",
    "bye",
    "bye bye",
    "you",
    "thanks",
];

/// True if `text` is nothing but one of Whisper's stock silence phrases.
pub fn is_stock_hallucination(text: &str) -> bool {
    let norm: String = text
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '\'' { c } else { ' ' })
        .collect();
    let norm = norm.split_whitespace().collect::<Vec<_>>().join(" ");
    !norm.is_empty() && STOCK_HALLUCINATIONS.contains(&norm.as_str())
}

/// RMS of `audio` between two Whisper timestamps (centiseconds), 16 kHz.
fn span_rms(audio: &[f32], t0: i64, t1: i64) -> f32 {
    let a = ((t0.max(0) as usize) * 160).min(audio.len());
    let b = ((t1.max(0) as usize) * 160).min(audio.len());
    if b <= a {
        return 0.0;
    }
    let s = &audio[a..b];
    (s.iter().map(|x| x * x).sum::<f32>() / s.len() as f32).sqrt()
}

/// Whether a decoded segment should be kept. A stock phrase ("Thank you.") is dropped
/// when Whisper itself thinks the stretch probably wasn't speech, or the audio under it
/// is quiet. A "thank you" you actually say out loud is loud and confident, so it stays.
pub fn keep_segment(text: &str, no_speech_prob: f32, rms: f32) -> bool {
    if !is_stock_hallucination(text) {
        return true;
    }
    no_speech_prob < 0.2 && rms >= 0.02
}

/// Join all decoded segments, dropping hallucinated stock phrases (see `keep_segment`).
/// Shared by both transcription paths.
pub fn collect_segments(state: &whisper_rs::WhisperState, audio: &[f32]) -> String {
    let mut out = String::new();
    for i in 0..state.full_n_segments() {
        let Some(seg) = state.get_segment(i) else { continue };
        let Ok(text) = seg.to_str() else { continue };
        let nsp = seg.no_speech_probability();
        let rms = span_rms(audio, seg.start_timestamp(), seg.end_timestamp());
        if keep_segment(text, nsp, rms) {
            out.push_str(text);
        } else {
            eprintln!("dropped hallucination {:?} (no_speech={:.2}, rms={:.4})", text.trim(), nsp, rms);
        }
    }
    out
}

/// Strip Whisper's subtitle-style non-speech artifacts from a raw transcription.
///
/// Removes bracketed tags — `[BLANK_AUDIO]`, `(Clapping)`, `(Upbeat music)`, `{music}` —
/// then returns an empty string if only punctuation/whitespace remains (a lone `.`
/// hallucination). Shared by both transcription paths (`transcribe_audio` command and
/// `run_pipeline`) so the filtering stays identical.
pub fn strip_non_speech(text: &str) -> String {
    let stripped = NON_SPEECH_TAG.replace_all(text, "");
    let stripped = stripped.trim();
    if stripped.chars().all(|c| !c.is_alphanumeric()) {
        String::new()
    } else {
        stripped.to_string()
    }
}
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Only the multilingual Turbo model can transcribe Hindi; every other bundled model is
/// an English-only build (the `.en` models and distil-large-v3). Keyed off the filename
/// so it works regardless of which model is active.
pub fn is_multilingual_model(filename: &str) -> bool {
    // Matches turbo and the full large-v3, quantized or not. (No distil-large-v3 file
    // is offered; it would be English-only and named `ggml-distil-...`.)
    std::path::Path::new(filename)
        .file_name()
        .and_then(|f| f.to_str())
        .is_some_and(|f| f.starts_with("ggml-large-v3"))
}

/// Transcribe with whichever engine the active model belongs to.
pub fn transcribe_with_model(
    model_path: &str,
    audio: &[f32],
    requested: &str,
    allowed: &[String],
    prompt: &str,
) -> Result<String, String> {
    if crate::parakeet::is_parakeet(model_path) {
        return crate::parakeet::transcribe(model_path, audio)
            .map(|text| crate::numbers::normalize(&text));
    }
    crate::parakeet::unload();
    let ctx = context_for(model_path)?;
    transcribe_samples(&ctx, audio, requested, allowed, is_multilingual_model(model_path), prompt)
}

/// What to do with a transcript after Whisper has written it down.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Finish {
    AsIs,
    /// Telugu speech, decoded as Kannada (see `dravidian.rs`): move it to Telugu script.
    Telugu,
    /// Telugu or Kannada, decoded as Kannada; the words decide which.
    TeluguOrKannada { telugu_first: bool },
}

/// The language to force on Whisper, and how to finish its output.
#[derive(Debug, Clone, PartialEq)]
pub struct LangChoice {
    pub whisper: String,
    pub finish: Finish,
}

impl LangChoice {
    /// Whisper writes Telugu far better through its Kannada decoder (see `dravidian.rs`).
    fn of(code: &str) -> Self {
        if code == "te" {
            Self { whisper: "kn".into(), finish: Finish::Telugu }
        } else {
            Self { whisper: code.into(), finish: Finish::AsIs }
        }
    }

    /// Apply `finish` to Whisper's output.
    pub fn finish(&self, text: &str) -> String {
        match self.finish {
            Finish::AsIs => text.to_string(),
            Finish::Telugu => crate::dravidian::kannada_to_telugu(text),
            Finish::TeluguOrKannada { telugu_first } => {
                if crate::dravidian::looks_telugu(text, telugu_first) {
                    crate::dravidian::kannada_to_telugu(text)
                } else {
                    text.to_string()
                }
            }
        }
    }
}

/// Indian languages, plus Thai, which Whisper's detector confuses with them. When one of
/// these scores, the speech is "an Indian language" even if the code itself isn't one the
/// user speaks.
const INDIC: &[&str] = &["hi", "ur", "ta", "te", "kn", "ml", "mr", "gu", "bn", "pa", "si", "ne", "sa", "as", "th"];
/// Below this share of non-Hindi Indic evidence (relative to Hindi), Indic speech is Hindi.
/// Clear Hindi measures ~0.002; Kannada and Telugu measure 0.07 and up (Whisper scores
/// them ~0.000 themselves and puts the mass on Tamil, Thai, Gujarati and Hindi).
const NOT_HINDI_RATIO: f32 = 0.03;

/// Picks the language to force on Whisper for a given request:
/// - English-only model → always `en` (it physically can't output anything else).
/// - An explicit language code → used as-is.
/// - `auto` on a multilingual model → run Whisper's language detector and force the
///   best-scoring language among the ones the user speaks (`allowed`), so a short or
///   noisy clip never comes back in some unrelated language (a common whisper.cpp issue).
///
/// Whisper's detector barely knows Telugu or Kannada (and other Indian languages), so for
/// those the Indian-language mass is pooled: Hindi gets it only when almost none of it
/// points away from Hindi.
///
/// `state` must be a fresh state for the model; we populate its mel here, and the later
/// `full()` call recomputes it — so this is purely an added detection pass.
pub fn resolve_language(
    state: &mut whisper_rs::WhisperState,
    audio: &[f32],
    requested: &str,
    allowed: &[String],
    multilingual: bool,
) -> Result<LangChoice, String> {
    if !multilingual {
        return Ok(LangChoice::of("en"));
    }
    if requested != "auto" && whisper_rs::get_lang_id(requested).is_some() {
        return Ok(LangChoice::of(requested));
    }
    let fallback = allowed.first().cloned().unwrap_or_else(|| "en".to_string());

    // Only the first 30 s can influence the result — see LANG_DETECT_SAMPLES.
    let head = &audio[..audio.len().min(LANG_DETECT_SAMPLES)];
    let probs = match state.pcm_to_mel(head, 1).ok().and_then(|_| state.lang_detect(0, 1).ok()) {
        Some((_, probs)) => probs,
        None => return Ok(LangChoice::of(&fallback)), // detection unavailable → the user's first language
    };
    let p = |code: &str| {
        whisper_rs::get_lang_id(code)
            .and_then(|id| probs.get(id as usize).copied())
            .unwrap_or(0.0)
    };
    // Speech in a language the user hasn't selected is reported, not guessed at.
    let top = (0..=whisper_rs::get_lang_max_id())
        .filter_map(|id| Some((whisper_rs::get_lang_str(id)?, probs.get(id as usize).copied()?)))
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(code, _)| code)
        .unwrap_or("en");
    if let Some(name) = not_selected(&p, allowed, top) {
        return Err(language_hint(&name));
    }
    if allowed.len() == 1 {
        return Ok(LangChoice::of(&fallback));
    }
    Ok(pick_language(&p, allowed))
}

/// The message shown when the speech isn't in one of the user's languages.
pub fn language_hint(name: &str) -> String {
    format!("Sounded like {name}. Add it in Language Model to dictate in it.")
}
const NO_FIT_HINT: &str = "Couldn't make that out in your languages. Speaking another? Add it in Language Model.";
/// True for the messages above: they're advice for the user, not transcription failures.
pub fn is_language_hint(msg: &str) -> bool {
    msg.ends_with("Language Model.") || msg.ends_with("to dictate in it.")
}

fn lang_name(code: &str) -> String {
    let n = whisper_rs::get_lang_id(code).and_then(whisper_rs::get_lang_str_full).unwrap_or(code);
    let mut c = n.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

/// If the speech is clearly in a language the user hasn't selected, its name.
/// `top` is the detector's best guess over every language.
fn not_selected(p: &dyn Fn(&str) -> f32, allowed: &[String], top: &str) -> Option<String> {
    let speaks = |c: &str| allowed.iter().any(|a| a == c);
    // (A Hindi lead can still be Telugu or Tamil in disguise, so that one is looked into.)
    if speaks(top) && top != "hi" {
        return None;
    }
    let best_selected = allowed.iter().map(|a| p(a)).fold(0.0f32, f32::max);
    // Something else entirely (Japanese, Spanish...), heard clearly.
    if !INDIC.contains(&top) {
        return (p(top) >= 0.6 && best_selected < 0.15).then(|| lang_name(top));
    }
    // An Indian language. Telugu and Kannada show up as Tamil (or Thai), so when the user
    // speaks either, Tamil-ish evidence belongs to them (see `pick_language`).
    let dravidian = speaks("te") || speaks("kn");
    let south = "a South Indian language (Tamil, Telugu, Kannada or Malayalam)".to_string();
    match top {
        "hi" | "ur" | "th" => {}
        "ta" if dravidian => {}
        "ta" if p("ta") >= 0.75 && best_selected < 0.15 => return Some(if speaks("ml") { lang_name("ta") } else { south }),
        "ta" => {}
        _ if p(top) >= 0.7 && best_selected < 0.15 => return Some(lang_name(top)),
        _ => {}
    }
    // No other Indian language selected, yet the evidence points away from Hindi.
    let others = allowed.iter().any(|c| INDIC.contains(&c.as_str()) && !["hi", "ur", "th"].contains(&c.as_str()));
    if !others {
        let hindi = p("hi") + p("ur");
        let not_hindi: f32 = INDIC.iter().filter(|c| !["hi", "ur"].contains(c)).map(|c| p(c)).sum();
        let rest = allowed.iter().filter(|c| c.as_str() != "hi" && c.as_str() != "ur").map(|a| p(a)).fold(0.0f32, f32::max);
        if not_hindi >= 0.2 && not_hindi >= hindi * 0.3 && hindi + not_hindi > rest {
            return Some(if ["ta", "te", "kn", "ml", "th", "hi"].contains(&top) { south } else { lang_name(top) });
        }
    }
    None
}

/// The decision half of `resolve_language`, given the detector's probabilities.
fn pick_language(p: &dyn Fn(&str) -> f32, allowed: &[String]) -> LangChoice {
    let speaks = |c: &str| allowed.iter().any(|a| a == c);
    let best_of = |codes: &[&String]| {
        codes
            .iter()
            .max_by(|a, b| p(a).partial_cmp(&p(b)).unwrap_or(std::cmp::Ordering::Equal))
            .map(|c| c.to_string())
    };

    // The Indian languages the user speaks other than Hindi/Urdu.
    let others: Vec<&String> = allowed
        .iter()
        .filter(|c| INDIC.contains(&c.as_str()) && !["hi", "ur", "th"].contains(&c.as_str()))
        .collect();
    if others.is_empty() {
        return LangChoice::of(&best_of(&allowed.iter().collect::<Vec<_>>()).unwrap_or_else(|| "en".into()));
    }

    // Pool the Indian-language mass. Codes the user speaks count for themselves; the rest
    // count as evidence for whichever of the user's Indian languages it belongs to.
    let hindi: f32 = ["hi", "ur"].iter().filter(|c| **c == "hi" || !speaks(c)).map(|c| p(c)).sum();
    let not_hindi: f32 = INDIC
        .iter()
        .filter(|c| !["hi", "ur"].contains(c) && (others.iter().any(|o| o == *c) || !speaks(c)))
        .map(|c| p(c))
        .sum();
    let indic = hindi + not_hindi;

    // Anything else the user speaks (English, Spanish...) competes on its own score.
    let rest: Vec<&String> = allowed.iter().filter(|c| c.as_str() != "hi" && !others.contains(c)).collect();
    // It has to be reasonably sure of itself, though: a short Indian-language clip scatters
    // the detector over unrelated languages and leaves English a small, misleading lead.
    if let Some(r) = best_of(&rest) {
        let unsure = p(&r) < 0.3 && indic >= p(&r) * 0.15;
        if p(&r) >= indic && !unsure {
            return LangChoice::of(&r);
        }
    }
    // On faint evidence, Hindi needs less to keep the clip.
    let ratio = if indic < 0.15 { 0.5 } else { NOT_HINDI_RATIO };
    if speaks("hi") && not_hindi < hindi * ratio {
        return LangChoice::of("hi");
    }

    // One of the user's other Indian languages. Telugu and Kannada are indistinguishable
    // to the detector, so when both are on the list the transcript decides.
    let te = others.iter().position(|c| c.as_str() == "te");
    let kn = others.iter().position(|c| c.as_str() == "kn");
    let mut best = best_of(&others).unwrap_or_else(|| others[0].to_string());
    // Telugu and Kannada score as Tamil; only a very sure Tamil is Tamil.
    if best == "ta" && p("ta") <= 0.75 {
        if let Some(i) = te.or(kn) {
            best = others[i].to_string();
        }
    }
    match (te, kn) {
        (Some(t), Some(k)) if best == "te" || best == "kn" => LangChoice {
            whisper: "kn".into(),
            finish: Finish::TeluguOrKannada { telugu_first: t < k },
        },
        _ => LangChoice::of(&best),
    }
}

/// Writing systems Whisper can wander into, and the languages that use each.
const SCRIPTS: &[(u32, u32, &[&str])] = &[
    (0x0370, 0x03FF, &["el"]),
    (0x0400, 0x052F, &["ru", "uk", "bg", "sr", "mk", "be", "kk", "mn", "tg", "ba", "tt"]),
    (0x0530, 0x058F, &["hy"]),
    (0x0590, 0x05FF, &["he", "yi"]),
    (0x0600, 0x06FF, &["ar", "ur", "fa", "ps", "sd"]),
    (0x0900, 0x097F, &["hi", "mr", "ne", "sa"]),
    (0x0980, 0x09FF, &["bn", "as"]),
    (0x0A00, 0x0A7F, &["pa"]),
    (0x0A80, 0x0AFF, &["gu"]),
    (0x0B80, 0x0BFF, &["ta"]),
    (0x0C00, 0x0C7F, &["te"]),
    (0x0C80, 0x0CFF, &["kn"]),
    (0x0D00, 0x0D7F, &["ml"]),
    (0x0D80, 0x0DFF, &["si"]),
    (0x0E00, 0x0E7F, &["th"]),
    (0x0E80, 0x0EFF, &["lo"]),
    (0x0F00, 0x0FFF, &["bo"]),
    (0x1000, 0x109F, &["my"]),
    (0x10A0, 0x10FF, &["ka"]),
    (0x1100, 0x11FF, &["ko"]),
    (0x1200, 0x137F, &["am"]),
    (0x1780, 0x17FF, &["km"]),
    (0x3040, 0x30FF, &["ja"]),
    (0x3400, 0x9FFF, &["zh", "ja", "yue"]),
    (0xAC00, 0xD7AF, &["ko"]),
];

/// False when `text` contains writing none of the user's languages use: Japanese kana
/// from someone who speaks English, Hindi, Telugu and Kannada, say. Forcing a language
/// on Whisper doesn't stop it writing in another one when the audio is unclear.
pub fn script_ok(text: &str, allowed: &[String]) -> bool {
    text.chars().all(|c| {
        match SCRIPTS.iter().find(|(lo, hi, _)| (*lo..=*hi).contains(&(c as u32))) {
            Some((_, _, langs)) => langs.iter().any(|l| allowed.iter().any(|a| a == l)),
            None => true,
        }
    })
}

/// Transcribe 16 kHz mono samples: choose the language (`resolve_language`), decode, clean
/// up. If the result is in a script none of the user's languages use, try their other
/// languages; if none of them fits either, there was nothing usable (empty string).
pub fn transcribe_samples(
    ctx: &WhisperContext,
    audio: &[f32],
    requested: &str,
    allowed: &[String],
    multilingual: bool,
    prompt: &str,
) -> Result<String, String> {
    let first = {
        let mut state = ctx.create_state().map_err(|e| format!("Speech engine error: {}", e))?;
        resolve_language(&mut state, audio, requested, allowed, multilingual)?
    };
    let mut tries = vec![first];
    if multilingual {
        let both = allowed.iter().any(|a| a == "te") && allowed.iter().any(|a| a == "kn");
        for a in allowed {
            let c = if both && (a == "te" || a == "kn") {
                let te = allowed.iter().position(|x| x == "te");
                let kn = allowed.iter().position(|x| x == "kn");
                LangChoice { whisper: "kn".into(), finish: Finish::TeluguOrKannada { telugu_first: te < kn } }
            } else {
                LangChoice::of(a)
            };
            if !tries.iter().any(|t| t.whisper == c.whisper) {
                tries.push(c);
            }
        }
    }
    for chosen in &tries {
        let mut state = ctx.create_state().map_err(|e| format!("Speech engine error: {}", e))?;
        // Beam search keeps several candidate wordings alive and picks the best overall.
        // Greedy (one guess per word, never revisited) is faster but skips and swaps
        // more words, most noticeably in fast or quiet speech.
        let mut params = FullParams::new(SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 });
        params.set_language(Some(&chosen.whisper));
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);
        // Non-speech suppression + the anti-repetition guards.
        apply_decoder_guards(&mut params);
        if !prompt.is_empty() {
            params.set_initial_prompt(prompt);
        }
        state.full(params, audio).map_err(|e| format!("Transcription failed: {}", e))?;
        // Backstops: collapse any decoder repetition loop, strip bracketed non-speech tags.
        // Telugu goes through Kannada; `finish` moves it back to Telugu script.
        let text = chosen.finish(&strip_non_speech(&collapse_repetitions(&collect_segments(&state, audio))));
        if !multilingual || script_ok(&text, allowed) {
            return Ok(if chosen.whisper == "en" {
                crate::numbers::normalize(&text)
            } else {
                text
            });
        }
        eprintln!("[whisper] '{}' decode came back in a foreign script, retrying: {}", chosen.whisper, text);
    }
    Err(NO_FIT_HINT.to_string())
}

#[cfg(test)]
mod lang_tests {
    use super::*;

    fn pick(probs: &[(&str, f32)], allowed: &[&str]) -> LangChoice {
        let allowed: Vec<String> = allowed.iter().map(|s| s.to_string()).collect();
        let p = |c: &str| probs.iter().find(|(k, _)| *k == c).map(|(_, v)| *v).unwrap_or(0.0);
        pick_language(&p, &allowed)
    }
    const MINE: &[&str] = &["en", "hi", "te", "kn"];
    fn hint(probs: &[(&str, f32)], allowed: &[&str]) -> Option<String> {
        let allowed: Vec<String> = allowed.iter().map(|s| s.to_string()).collect();
        let p = |c: &str| probs.iter().find(|(k, _)| *k == c).map(|(_, v)| *v).unwrap_or(0.0);
        let top = probs.iter().max_by(|a, b| a.1.partial_cmp(&b.1).unwrap()).unwrap().0;
        not_selected(&p, &allowed, top)
    }

    #[test]
    fn short_clips_are_not_handed_to_english() {
        // two-word Kannada, two-word Hindi: the detector scatters, English leads by a hair
        let kn_b = [("ru", 0.118), ("id", 0.118), ("en", 0.104), ("th", 0.011), ("hi", 0.005), ("ur", 0.003), ("ta", 0.003)];
        let hi_a = [("en", 0.111), ("ar", 0.081), ("hi", 0.032), ("ur", 0.018), ("th", 0.010), ("ta", 0.002)];
        assert_eq!(pick(&kn_b, MINE).finish, EITHER);
        assert_eq!(pick(&hi_a, MINE).whisper, "hi");
        assert_eq!(hint(&kn_b, MINE), None);
    }

    #[test]
    fn tamil_only_when_sure() {
        let te_d = [("ta", 0.63), ("hi", 0.185), ("th", 0.044), ("en", 0.017)];
        let ta_a = [("ta", 0.885), ("hi", 0.032), ("th", 0.027)];
        assert_eq!(pick(&te_d, &["en", "hi", "te", "ta"]), LangChoice { whisper: "kn".into(), finish: Finish::Telugu });
        assert_eq!(pick(&ta_a, &["en", "hi", "te", "ta"]).whisper, "ta");
    }

    #[test]
    fn unselected_languages_are_reported() {
        let ta_a = [("ta", 0.885), ("hi", 0.032), ("th", 0.027)];
        let te_c = [("hi", 0.376), ("ta", 0.294), ("th", 0.074), ("gu", 0.029)];
        assert_eq!(hint(&[("ja", 0.9), ("en", 0.02)], MINE).as_deref(), Some("Japanese"));
        assert_eq!(hint(&[("bn", 0.9), ("hi", 0.03)], MINE).as_deref(), Some("Bengali"));
        assert!(hint(&ta_a, &["en", "hi"]).unwrap().contains("South Indian"));
        assert!(hint(&te_c, &["en", "hi"]).unwrap().contains("South Indian"));
        // ...but not when it's one of theirs, or plain Hindi / English
        assert_eq!(hint(&ta_a, MINE), None);
        assert_eq!(hint(&te_c, MINE), None);
        assert_eq!(hint(&[("hi", 0.927), ("ur", 0.053), ("th", 0.001)], &["en", "hi"]), None);
        assert_eq!(hint(&[("en", 0.78), ("hi", 0.149)], &["en", "hi"]), None);
        assert!(is_language_hint(&language_hint("Tamil")) && is_language_hint(NO_FIT_HINT));
    }

    #[test]
    fn foreign_scripts_are_caught() {
        let mine: Vec<String> = MINE.iter().map(|s| s.to_string()).collect();
        assert!(!script_ok("身長、ほうへいほう、しょうほう。こんにちは。", &mine));
        assert!(!script_ok("Привет", &mine));
        assert!(script_ok("Hello, नमस्ते, నమస్కారం, ನಮಸ್ಕಾರ. F = ma!", &mine));
        assert!(script_ok("こんにちは", &["ja".to_string()]));
    }

    const EITHER: Finish = Finish::TeluguOrKannada { telugu_first: true };

    // Detector output measured on real clips (large-v3-turbo).
    #[test]
    fn hindi_stays_hindi() {
        assert_eq!(pick(&[("hi", 0.909), ("ur", 0.07), ("th", 0.002)], MINE).whisper, "hi");
        assert_eq!(pick(&[("hi", 0.927), ("ur", 0.053), ("en", 0.006), ("th", 0.001)], MINE).whisper, "hi");
    }

    #[test]
    fn english_stays_english() {
        assert_eq!(pick(&[("en", 1.0)], MINE).whisper, "en");
        assert_eq!(pick(&[("en", 0.78), ("hi", 0.149), ("ur", 0.012)], MINE).whisper, "en");
    }

    #[test]
    fn telugu_and_kannada_are_not_hindi() {
        let te_short = [("ta", 0.379), ("hi", 0.187), ("th", 0.069), ("en", 0.025), ("ur", 0.013)];
        let kn_d = [("hi", 0.614), ("en", 0.037), ("th", 0.037), ("ur", 0.029), ("ta", 0.007)];
        let kn_a = [("hi", 0.459), ("ta", 0.15), ("th", 0.087), ("ur", 0.011), ("mr", 0.006), ("gu", 0.006)];
        for probs in [&te_short[..], &kn_d[..], &kn_a[..]] {
            assert_eq!(pick(probs, MINE).finish, EITHER, "{probs:?}");
        }
        // With only one of them on the list, that one.
        assert_eq!(pick(&te_short, &["en", "hi", "kn"]), LangChoice::of("kn"));
        assert_eq!(pick(&te_short, &["en", "hi", "te"]), LangChoice { whisper: "kn".into(), finish: Finish::Telugu });
    }

    #[test]
    fn without_other_indian_languages_nothing_changes() {
        let te_short = [("ta", 0.379), ("hi", 0.187), ("th", 0.069), ("en", 0.025)];
        assert_eq!(pick(&te_short, &["en", "hi"]).whisper, "hi");
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub filename: String,
    pub url: String,
    pub size_mb: u32,
    pub ram_mb: u32,
    pub description: String,
    /// Small companion files fetched before the main one: (url, filename beside it).
    #[serde(skip)]
    pub extras: Vec<(String, String)>,
}

/// The models offered on this platform. The names shown to users are LocalFlow's own;
/// the engines and models behind them are credited on the About page.
pub fn available_models() -> Vec<ModelInfo> {
    // Apple Silicon: Swift replaces Plus, and Max (compressed) is the top multilingual
    // option. Elsewhere the second engine is untested, so the original four stay.
    let offered: &[&str] = if cfg!(target_os = "macos") {
        &["base.en", "small.en", "parakeet-tdt-v2", "large-v3-turbo", "large-v3-q5"]
    } else {
        &["base.en", "small.en", "medium.en", "large-v3-turbo"]
    };
    all_models().into_iter().filter(|m| offered.contains(&m.id.as_str())).collect()
}

fn all_models() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            id: "base.en".into(),
            name: "Flow Lite".into(),
            filename: "ggml-base.en-q5_1.bin".into(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin".into(),
            size_mb: 57,
            ram_mb: 160,
            description: "English. The smallest and lightest. Quick, with okay accuracy.".into(),
            extras: vec![],
        },
        ModelInfo {
            id: "small.en".into(),
            name: "Flow Classic".into(),
            filename: "ggml-small.en-q5_1.bin".into(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin".into(),
            size_mb: 190,
            ram_mb: 310,
            description: "English. Light on memory with good accuracy for everyday use.".into(),
            extras: vec![],
        },
        // A different engine (NVIDIA Parakeet via ONNX Runtime, see parakeet.rs). The
        // model is a folder; the encoder is the big file and marks it as downloaded.
        ModelInfo {
            id: "parakeet-tdt-v2".into(),
            name: "Flow Swift".into(),
            filename: format!("{}/{}", crate::parakeet::DIR, crate::parakeet::ENCODER),
            url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx/resolve/main/encoder-model.int8.onnx".into(),
            size_mb: 661,
            ram_mb: 1100,
            description: "English. Our fastest and most accurate English model: text appears almost instantly and words are rarely dropped. Doesn't use the dictionary's listening hints, but its \"sounds like\" fixes still apply.".into(),
            extras: vec![
                ("https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx/resolve/main/vocab.txt".into(), "vocab.txt".into()),
                ("https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx/resolve/main/decoder_joint-model.int8.onnx".into(), "decoder_joint-model.onnx".into()),
            ],
        },
        ModelInfo {
            id: "medium.en".into(),
            name: "Flow Plus".into(),
            filename: "ggml-medium.en-q5_0.bin".into(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en-q5_0.bin".into(),
            size_mb: 514,
            ram_mb: 660,
            description: "English. More accurate than Classic but slower.".into(),
            extras: vec![],
        },
        ModelInfo {
            id: "large-v3-turbo".into(),
            name: "Flow Multilingual".into(),
            filename: "ggml-large-v3-turbo-q5_0.bin".into(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin".into(),
            size_mb: 874,
            ram_mb: 1000,
            description: "Hindi and 90+ other languages, and mixing them with English.".into(),
            extras: vec![],
        },
        ModelInfo {
            id: "large-v3-turbo-full".into(),
            name: "Flow Multilingual, uncompressed".into(),
            filename: "ggml-large-v3-turbo.bin".into(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin".into(),
            size_mb: 1620,
            ram_mb: 1900,
            description: "The same model as Flow Multilingual without the compression. Slightly more accurate, same speed.".into(),
            extras: vec![],
        },
        ModelInfo {
            id: "large-v3-q5".into(),
            name: "Flow Multilingual Max".into(),
            filename: "ggml-large-v3-q5_0.bin".into(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin".into(),
            size_mb: 1080,
            ram_mb: 1500,
            description: "Our most accurate model for Hindi, Telugu, Kannada and other languages, but several times slower.".into(),
            extras: vec![],
        },
        ModelInfo {
            id: "large-v3".into(),
            name: "Flow Multilingual Max, uncompressed".into(),
            filename: "ggml-large-v3.bin".into(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin".into(),
            size_mb: 3100,
            ram_mb: 3900,
            description: "Flow Multilingual Max at full quality. The slowest and largest option.".into(),
            extras: vec![],
        },
    ]
}

pub fn get_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    path.push("models");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

pub fn get_active_model_filename(app: &AppHandle) -> String {
    let mut settings_path = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(_) => return "ggml-small.en-q5_1.bin".to_string(),
    };
    settings_path.push("settings.json");

    if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).unwrap_or_default();
        let val: serde_json::Value = serde_json::from_str(&content).unwrap_or_default();
        val["active_model"]
            .as_str()
            .unwrap_or("ggml-small.en-q5_1.bin")
            .to_string()
    } else {
        "ggml-small.en-q5_1.bin".to_string()
    }
}

pub fn get_active_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let models_dir = get_models_dir(app)?;
    let active_filename = get_active_model_filename(app);
    Ok(models_dir.join(active_filename))
}

#[tauri::command]
pub fn list_models(app: AppHandle) -> Vec<serde_json::Value> {
    let models = available_models();
    let models_dir = get_models_dir(&app).unwrap_or_default();
    let active_filename = get_active_model_filename(&app);

    models
        .iter()
        .map(|m| {
            let path = models_dir.join(&m.filename);
            let downloaded = path.exists();
            let size_on_disk = if downloaded {
                fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0)
            } else {
                0
            };
            serde_json::json!({
                "id": m.id,
                "name": m.name,
                "filename": m.filename,
                "url": m.url,
                "size_mb": m.size_mb,
                "ram_mb": m.ram_mb,
                "description": m.description,
                "downloaded": downloaded,
                "size_on_disk": size_on_disk,
                "is_active": m.filename == active_filename,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn download_model(app: AppHandle, model_id: String) -> Result<String, String> {
    let models = available_models();
    let model = models
        .iter()
        .find(|m| m.id == model_id)
        .ok_or_else(|| format!("Unknown model: {}", model_id))?
        .clone();

    let models_dir = get_models_dir(&app)?;
    let dest_path = models_dir.join(&model.filename);

    if dest_path.exists() {
        return Ok(format!("Model {} already downloaded", model.name));
    }

    // Folder models: make the folder and fetch the small companion files first, so the
    // main file landing last is what marks the model as complete.
    let model_dir = dest_path.parent().unwrap_or(&models_dir).to_path_buf();
    fs::create_dir_all(&model_dir).map_err(|e| e.to_string())?;
    for (url, name) in &model.extras {
        let resp = reqwest::get(url).await.map_err(|e| format!("Download failed: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("Download failed: HTTP {} for {}", resp.status().as_u16(), url));
        }
        let bytes = resp.bytes().await.map_err(|e| format!("Download failed: {}", e))?;
        fs::write(model_dir.join(name), &bytes).map_err(|e| format!("Failed to save {}: {}", name, e))?;
    }

    println!("Downloading model {} from {}...", model.name, model.url);

    let response = reqwest::get(&model.url)
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    // Reject error responses (e.g. HuggingFace 404 returns a tiny "Entry not found"
    // body that would otherwise be saved as a corrupt model file).
    if !response.status().is_success() {
        return Err(format!(
            "Download failed: HTTP {} for {}",
            response.status().as_u16(),
            model.url
        ));
    }

    let total_size = response
        .content_length()
        .ok_or_else(|| "Failed to get content length".to_string())?;

    // Sanity check: a real model is at least a few MB; anything tiny is an error page.
    if total_size < 1_000_000 {
        return Err(format!(
            "Download failed: server returned only {} bytes (not a valid model)",
            total_size
        ));
    }

    let tmp_path = dest_path.with_extension("download");
    if tmp_path.exists() {
        let _ = fs::remove_file(&tmp_path);
    }

    let mut file = std::fs::File::create(&tmp_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut stream = response.bytes_stream();
    // Drop any stale cancel flag from a previous attempt before we start streaming.
    crate::download::clear_cancel(&model.id);

    while let Some(item) = stream.next().await {
        // Abort promptly if the user pressed Cancel for this download.
        if crate::download::cancel_requested(&model.id) {
            drop(file);
            let _ = fs::remove_file(&tmp_path);
            crate::download::clear_cancel(&model.id);
            return Err("Download cancelled".to_string());
        }

        let chunk = item.map_err(|e| {
            let _ = fs::remove_file(&tmp_path);
            format!("Error while downloading: {}", e)
        })?;

        file.write_all(&chunk).map_err(|e| {
            let _ = fs::remove_file(&tmp_path);
            format!("Failed to write chunk: {}", e)
        })?;

        downloaded += chunk.len() as u64;
        let percent = (downloaded * 100 / total_size) as u32;

        if last_emit.elapsed().as_millis() > 100 || percent == 100 {
            app.emit(
                "download-progress",
                serde_json::json!({
                    "id": model.id,
                    "progress": percent,
                }),
            )
            .ok();
            last_emit = std::time::Instant::now();
        }
    }

    file.sync_all().map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to sync file: {}", e)
    })?;
    drop(file);

    if let Err(e) = fs::rename(&tmp_path, &dest_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to save final model file: {}", e));
    }

    println!("Model saved to {:?}", dest_path);
    Ok(format!(
        "Downloaded {} ({} MB)",
        model.name,
        downloaded / 1_000_000
    ))
}

#[tauri::command]
pub async fn transcribe_audio(
    app: AppHandle,
    audio_state: tauri::State<'_, Arc<crate::audio::AudioState>>,
    pipeline: tauri::State<'_, Arc<crate::pipeline::PipelineState>>,
    language: Option<String>,
    initial_prompt: Option<String>,
) -> Result<String, String> {
    let romanize = *pipeline.romanize.lock().unwrap();
    let capture_rate = *audio_state.sample_rate.lock().unwrap();
    let audio_data: Vec<f32> = {
        let mut buffer = audio_state.buffer.lock().unwrap();
        if buffer.is_empty() {
            return Err("Audio buffer is empty".into());
        }
        let samples = buffer.drain(..).collect();
        // `drain` empties the deque but keeps its capacity, which for a long recording is
        // ~115 MB. Hand it back rather than holding it for the rest of the session — the
        // next recording reserves what it needs again. Mirrors `run_pipeline` in lib.rs.
        buffer.shrink_to_fit();
        samples
    };

    // Resample to 16 kHz mono — Whisper requires it and mics may capture at other rates.
    let audio_data = crate::audio::resample_to_16k(audio_data, capture_rate);

    // Silence gate: if the clip is basically quiet (hotkey tapped with no speech, or a
    // long silent lead-in) or too short, don't feed it to Whisper — on near-silence it
    // hallucinates subtitle-style filler like "[BLANK_AUDIO]", "(clicking)", "{music}"
    // or a lone ".". Returning empty here avoids injecting/saving that garbage.
    let rms = if audio_data.is_empty() {
        0.0
    } else {
        (audio_data.iter().map(|s| s * s).sum::<f32>() / audio_data.len() as f32).sqrt()
    };
    if rms < 0.005 || audio_data.len() < 16_000 / 2 {
        return Ok(String::new());
    }

    let model_path = get_active_model_path(&app)?;

    if !model_path.exists() {
        return Err(format!(
            "Model not found at {:?}. Please download a model first.",
            model_path
        ));
    }

    let lang = language.unwrap_or_else(|| "en".to_string());
    let prompt = initial_prompt.unwrap_or_default();
    let allowed_langs: Vec<String> = {
        use tauri::Manager;
        app.try_state::<std::sync::Arc<crate::pipeline::PipelineState>>()
            .map(|p| p.languages.lock().unwrap().clone())
            .unwrap_or_else(|| vec!["en".to_string(), "hi".to_string()])
    };

    let result = tauri::async_runtime::spawn_blocking(move || {
        let model_path_str = model_path.to_str().unwrap().to_string();

        transcribe_with_model(&model_path_str, &audio_data, &lang, &allowed_langs, &prompt)
    })
    .await
    .map_err(|e| format!("Thread panicked: {}", e))??;

    let result = if romanize {
        crate::translit::devanagari_to_latin(&result)
    } else {
        result
    };

    Ok(result)
}

#[tauri::command]
pub fn set_active_model(app: AppHandle, filename: String) -> Result<(), String> {
    let mut settings_path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    settings_path.push("settings.json");

    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    settings["active_model"] = serde_json::json!(filename);
    fs::write(
        &settings_path,
        serde_json::to_string_pretty(&settings).unwrap(),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn delete_model(app: AppHandle, model_id: String) -> Result<(), String> {
    let models = available_models();
    let model = models
        .iter()
        .find(|m| m.id == model_id)
        .ok_or_else(|| format!("Unknown model: {}", model_id))?;

    let models_dir = get_models_dir(&app)?;
    let dest_path = models_dir.join(&model.filename);

    if dest_path.exists() {
        fs::remove_file(&dest_path).map_err(|e| format!("Failed to delete model file: {}", e))?;
        for (_, name) in &model.extras {
            let _ = fs::remove_file(dest_path.with_file_name(name));
        }
        if !model.extras.is_empty() {
            // Only goes if empty, i.e. it held nothing but this model.
            let _ = dest_path.parent().map(fs::remove_dir);
            crate::parakeet::unload();
        }
        // The cache is keyed by path, which cannot tell a re-downloaded file from the
        // one just deleted. Drop it so the next dictation loads from disk again.
        invalidate_model_cache();
    }

    // Reset active model settings if the deleted model was active
    let mut settings_path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    settings_path.push("settings.json");

    if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).unwrap_or_default();
        let mut val: serde_json::Value = serde_json::from_str(&content).unwrap_or_default();
        if let Some(active) = val["active_model"].as_str() {
            if active == model.filename {
                val["active_model"] = serde_json::json!("ggml-small.en-q5_1.bin");
                let _ = fs::write(&settings_path, serde_json::to_string_pretty(&val).unwrap());
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn stock_thank_you_dropped_on_quiet_audio() {
        use super::{is_stock_hallucination, keep_segment};
        assert!(is_stock_hallucination(" Thank you."));
        assert!(is_stock_hallucination("Thanks for watching!"));
        assert!(!is_stock_hallucination("Thank you for the update, see you Monday."));
        // Hallucinated over silence / flagged as non-speech -> dropped.
        assert!(!keep_segment(" Thank you.", 0.05, 0.004));
        assert!(!keep_segment(" Thank you.", 0.6, 0.08));
        // Actually said it, clearly -> kept.
        assert!(keep_segment(" Thank you.", 0.02, 0.08));
        // Ordinary speech is never touched.
        assert!(keep_segment(" Send the report.", 0.9, 0.0));
    }

    use super::collapse_repetitions;

    /// Resident set size of this process, in MB. macOS `ps` reports RSS in KB.
    #[cfg(unix)]
    fn rss_mb() -> u64 {
        let out = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .expect("ps");
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse::<u64>()
            .expect("rss")
            / 1024
    }

    /// Proves the cached model's memory is actually returned to the OS once it goes
    /// idle — not merely that the `Arc` was dropped. Half a gigabyte staying resident
    /// after a dictation is the whole bug this guards against.
    ///
    /// Needs a real model, so it is opt-in: point `LOCALFLOW_TEST_MODEL` at a `.bin`
    /// and run `cargo test -- --ignored --nocapture releases_model_memory_when_idle`.
    /// It sleeps past `MODEL_IDLE_TTL`, so it takes about two minutes.
    #[test]
    #[ignore = "needs a local model file and sleeps past the idle TTL"]
    #[cfg(unix)]
    fn releases_model_memory_when_idle() {
        let Ok(model) = std::env::var("LOCALFLOW_TEST_MODEL") else {
            panic!("set LOCALFLOW_TEST_MODEL to a Whisper .bin path");
        };

        let baseline = rss_mb();
        let ctx = super::context_for(&model).expect("load model");
        let loaded = rss_mb();
        // Dropping our handle leaves the cache holding the only reference — the state a
        // finished dictation leaves behind.
        drop(ctx);
        assert!(
            loaded > baseline + 100,
            "model should cost >100 MB resident, went {baseline} -> {loaded} MB"
        );

        // Sweep interval plus TTL, plus slack for the sleep to land after the check.
        std::thread::sleep(super::MODEL_IDLE_TTL + super::REAP_INTERVAL * 2);
        let idle = rss_mb();

        assert!(
            super::MODEL_CACHE
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .is_none(),
            "cache should be empty after the idle TTL"
        );
        // Allow generous slack: the allocator may keep some arenas mapped.
        assert!(
            idle < baseline + 150,
            "memory should be released: baseline {baseline} MB, loaded {loaded} MB, \
             still {idle} MB after idle"
        );
        println!("RSS  baseline {baseline} MB -> loaded {loaded} MB -> idle {idle} MB");
    }

    #[test]
    fn collapses_a_decoder_loop() {
        // The shape of a real 3-minute dictation that failed: a few good sentences, then
        // one unbroken run of the same question for the rest of the recording.
        let loop_sentence = " How are we going to get this in the market?";
        let mut raw = String::from("Now we have to make a script for this.");
        for _ in 0..47 {
            raw.push_str(loop_sentence);
        }
        assert_eq!(
            collapse_repetitions(&raw),
            "Now we have to make a script for this. How are we going to get this in the market?"
        );
    }

    #[test]
    fn keeps_deliberate_short_repetition() {
        // Two repeats of a short sentence is emphasis, not a decoder loop.
        assert_eq!(collapse_repetitions("No. No."), "No. No.");
        assert_eq!(collapse_repetitions("Wait! Wait!"), "Wait! Wait!");
    }

    #[test]
    fn a_long_run_of_a_short_sentence_is_still_a_loop() {
        assert_eq!(collapse_repetitions("No. No. No. No. No."), "No.");
    }

    #[test]
    fn a_substantial_sentence_repeating_twice_is_a_loop() {
        assert_eq!(
            collapse_repetitions("Send the report to Jim. Send the report to Jim."),
            "Send the report to Jim."
        );
    }

    #[test]
    fn non_consecutive_repeats_are_left_alone() {
        // Coming back to the same point later is normal speech, not a loop.
        let text = "Ship it Monday. The tests are green. Ship it Monday.";
        assert_eq!(collapse_repetitions(text), text);
    }

    #[test]
    fn matching_ignores_case_and_spacing() {
        assert_eq!(
            collapse_repetitions("We should ship it now.  we should ship it now."),
            "We should ship it now."
        );
    }

    #[test]
    fn ordinary_text_is_untouched() {
        let text = "First we buy water. Then we buy bread. It was raining.";
        assert_eq!(collapse_repetitions(text), text);
        assert_eq!(collapse_repetitions(""), "");
    }

    #[test]
    fn does_not_split_decimals_or_domains() {
        let text = "Visit example.com and pay 3.50 today.";
        assert_eq!(collapse_repetitions(text), text);
    }
}
