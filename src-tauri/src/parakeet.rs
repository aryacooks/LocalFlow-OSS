/// parakeet.rs — NVIDIA Parakeet (English) as a second speech engine.
///
/// Whisper stays the engine for every other model; this runs the one Parakeet model
/// through ONNX Runtime (`parakeet-rs`). It is English only, has no language detection
/// and takes no dictionary prompt, but it is much faster than Whisper and rarely drops
/// or invents words. The model is a folder (encoder, decoder, vocab) under `models/`.
use parakeet_rs::{ExecutionConfig, ParakeetTDT, Transcriber};
use std::sync::{Mutex, Once, OnceLock};
use std::time::{Duration, Instant};

/// Folder under the models dir, and the file whose presence means "downloaded".
pub const DIR: &str = "parakeet-tdt-0.6b-v2";
pub const ENCODER: &str = "encoder-model.onnx";

/// Is this model path/filename the Parakeet model?
pub fn is_parakeet(model: &str) -> bool {
    model.contains(DIR)
}

struct Loaded {
    dir: String,
    model: ParakeetTDT,
    last_used: Instant,
}

static MODEL: Mutex<Option<Loaded>> = Mutex::new(None);
static REAPER: Once = Once::new();
/// Same idle window as the Whisper cache: stay warm for follow-up dictations, then free
/// the memory.
const IDLE_TTL: Duration = Duration::from_secs(90);

/// ONNX Runtime allows one environment per process.
fn config() -> Result<ExecutionConfig, String> {
    static CONFIG: OnceLock<Result<ExecutionConfig, String>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let env = parakeet_rs::ort::init().build().map_err(|e| format!("Speech engine failed to start: {e}"))?;
            Ok(ExecutionConfig::new().with_environment(env))
        })
        .clone()
}

/// Free the model now (the user switched to or deleted another model).
pub fn unload() {
    *MODEL.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

fn spawn_reaper() {
    REAPER.call_once(|| {
        std::thread::Builder::new()
            .name("parakeet-model-reaper".into())
            .spawn(|| loop {
                std::thread::sleep(Duration::from_secs(15));
                // try_lock: a dictation in progress holds the lock, and is not idle.
                if let Ok(mut m) = MODEL.try_lock() {
                    if m.as_ref().is_some_and(|l| l.last_used.elapsed() >= IDLE_TTL) {
                        *m = None;
                    }
                }
            })
            .ok();
    });
}

/// The model handles a few minutes at most in one go, so long takes are cut into pieces
/// of about a minute, each cut placed at the quietest moment nearby (a pause, not the
/// middle of a word).
fn pieces(audio: &[f32]) -> Vec<&[f32]> {
    const RATE: usize = crate::audio::SAMPLE_RATE as usize;
    const TARGET: usize = 60 * RATE;
    const SEARCH: usize = 5 * RATE;
    const WINDOW: usize = RATE / 10;
    let mut out = Vec::new();
    let mut start = 0;
    while audio.len() - start > TARGET + SEARCH {
        let (lo, hi) = (start + TARGET - SEARCH, start + TARGET + SEARCH);
        let cut = (lo..hi)
            .step_by(WINDOW / 2)
            .min_by(|&a, &b| {
                let e = |i: usize| audio[i..(i + WINDOW).min(audio.len())].iter().map(|s| s * s).sum::<f32>();
                e(a).total_cmp(&e(b))
            })
            .map_or(start + TARGET, |i| i + WINDOW / 2);
        out.push(&audio[start..cut]);
        start = cut;
    }
    out.push(&audio[start..]);
    out
}

/// Transcribe 16 kHz mono audio with the model in `model_path` (the encoder file or its
/// folder).
pub fn transcribe(model_path: &str, audio: &[f32]) -> Result<String, String> {
    spawn_reaper();
    let path = std::path::Path::new(model_path);
    let dir = if path.is_dir() { path } else { path.parent().ok_or("Bad model path")? };
    let dir_str = dir.to_string_lossy().to_string();

    let mut guard = MODEL.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if guard.as_ref().is_none_or(|l| l.dir != dir_str) {
        *guard = None;
        // Never hold two speech models in memory at once.
        crate::whisper::invalidate_model_cache();
        let model = ParakeetTDT::from_pretrained(dir, Some(config()?))
            .map_err(|e| format!("Failed to load the speech model: {e}"))?;
        *guard = Some(Loaded { dir: dir_str, model, last_used: Instant::now() });
    }
    let loaded = guard.as_mut().unwrap();

    let mut parts = Vec::new();
    for piece in pieces(audio) {
        let result = loaded
            .model
            .transcribe_samples(piece.to_vec(), crate::audio::SAMPLE_RATE, 1, None)
            .map_err(|e| format!("Transcription failed: {e}"))?;
        let text = result.text.trim().to_string();
        if !text.is_empty() {
            parts.push(text);
        }
    }
    loaded.last_used = Instant::now();
    Ok(parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::pieces;

    #[test]
    fn long_takes_are_cut_at_a_pause() {
        const RATE: usize = 16_000;
        assert_eq!(pieces(&vec![0.1; 30 * RATE]).len(), 1);
        // 150 s of "speech" with a silent gap at 58–59 s.
        let mut audio = vec![0.1f32; 150 * RATE];
        audio[58 * RATE..59 * RATE].fill(0.0);
        let p = pieces(&audio);
        assert_eq!(p.iter().map(|x| x.len()).sum::<usize>(), audio.len());
        assert!(p.len() >= 2);
        assert!((58 * RATE..=59 * RATE).contains(&p[0].len()), "first cut at {}", p[0].len());
    }
}
