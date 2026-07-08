use futures_util::StreamExt;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

/// Matches subtitle-style non-speech tags Whisper emits on noise/silence:
/// `[BLANK_AUDIO]`, `(clicking)`, `(Upbeat music)`, `{music}`, `[ Applause ]`, etc.
static NON_SPEECH_TAG: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[\[\(\{][^\]\)\}]*[\]\)\}]").unwrap());

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
    filename.contains("large-v3-turbo")
}

/// LocalFlow supports English + Hindi only. This picks the language code to force on
/// Whisper for a given request:
/// - English-only model → always `en` (it physically can't output Hindi).
/// - Explicit `en` / `hi` → used as-is.
/// - `auto` (or anything else) on a multilingual model → run Whisper's language
///   detector and force whichever of English/Hindi scores higher, so a short or noisy
///   clip never comes back as some random third language (a common whisper.cpp issue).
///
/// `state` must be a fresh state for the model; we populate its mel here, and the later
/// `full()` call recomputes it — so this is purely an added detection pass.
pub fn resolve_language(
    state: &mut whisper_rs::WhisperState,
    audio: &[f32],
    requested: &str,
    multilingual: bool,
) -> String {
    if !multilingual {
        return "en".to_string();
    }
    if requested == "en" || requested == "hi" {
        return requested.to_string();
    }

    if state.pcm_to_mel(audio, 1).is_ok() {
        if let Ok((_, probs)) = state.lang_detect(0, 1) {
            let prob_of = |code: &str| {
                whisper_rs::get_lang_id(code)
                    .and_then(|id| probs.get(id as usize).copied())
                    .unwrap_or(0.0)
            };
            return if prob_of("hi") > prob_of("en") {
                "hi".to_string()
            } else {
                "en".to_string()
            };
        }
    }
    "en".to_string() // detection unavailable → safe default
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
}

pub fn available_models() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            id: "tiny.en".into(),
            name: "Tiny English".into(),
            filename: "ggml-tiny.en-q5_1.bin".into(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en-q5_1.bin".into(),
            size_mb: 32,
            ram_mb: 130,
            description: "Quickest, but makes the most mistakes. Fine for short notes.".into(),
        },
        ModelInfo {
            id: "base.en".into(),
            name: "Base English".into(),
            filename: "ggml-base.en-q5_1.bin".into(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin".into(),
            size_mb: 57,
            ram_mb: 160,
            description: "Quick, with okay accuracy.".into(),
        },
        ModelInfo {
            id: "small.en".into(),
            name: "Small English (Default)".into(),
            filename: "ggml-small.en-q5_1.bin".into(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin".into(),
            size_mb: 190,
            ram_mb: 310,
            description: "Recommended for most people — fast and accurate for everyday use.".into(),
        },
        ModelInfo {
            id: "medium.en".into(),
            name: "Medium English".into(),
            filename: "ggml-medium.en-q5_0.bin".into(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en-q5_0.bin".into(),
            size_mb: 514,
            ram_mb: 660,
            description: "More accurate but slower. Good for longer or important writing.".into(),
        },
        ModelInfo {
            id: "distil-large-v3".into(),
            name: "Distil-Whisper Large V3".into(),
            filename: "ggml-distil-large-v3.bin".into(),
            url: "https://huggingface.co/distil-whisper/distil-large-v3-ggml/resolve/main/ggml-distil-large-v3.bin".into(),
            size_mb: 756,
            ram_mb: 900,
            description: "Very accurate English, and faster than the biggest model.".into(),
        },
        ModelInfo {
            id: "large-v3-turbo".into(),
            name: "Large V3 Turbo (Multilingual)".into(),
            filename: "ggml-large-v3-turbo-q5_0.bin".into(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin".into(),
            size_mb: 874,
            ram_mb: 1000,
            description: "Best for Hindi and other languages, and for mixing Hindi with English.".into(),
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
        buffer.drain(..).collect()
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
    let multilingual = is_multilingual_model(&model_path.to_string_lossy());

    let result = tauri::async_runtime::spawn_blocking(move || {
        let model_path_str = model_path.to_str().unwrap().to_string();

        let ctx =
            WhisperContext::new_with_params(&model_path_str, WhisperContextParameters::default())
                .map_err(|e| format!("Failed to load Whisper model: {}", e))?;

        let mut state = ctx
            .create_state()
            .map_err(|e| format!("Failed to create Whisper state: {}", e))?;

        // Constrain to English/Hindi only (auto picks the higher-scoring of the two).
        let chosen_lang = resolve_language(&mut state, &audio_data, &lang, multilingual);
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(&chosen_lang));
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);
        // Suppress the subtitle-style non-speech output Whisper learned from its training
        // captions: blank/whitespace-only tokens and non-speech tags like "[MUSIC]" or
        // "(clicking)". This is the source-level fix; the post-filter below is a backstop.
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);

        if !prompt.is_empty() {
            params.set_initial_prompt(&prompt);
        }

        state
            .full(params, &audio_data[..])
            .map_err(|e| format!("Transcription failed: {}", e))?;

        let num_segments = state.full_n_segments();
        let mut transcription = String::new();

        for i in 0..num_segments {
            if let Some(segment) = state.get_segment(i) {
                if let Ok(text) = segment.to_str() {
                    transcription.push_str(text);
                }
            }
        }

        // Backstop: strip any bracketed non-speech tag that slipped through and drop the
        // result if nothing but punctuation/whitespace remains (a stray "." hallucination).
        Ok::<String, String>(strip_non_speech(&transcription))
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
