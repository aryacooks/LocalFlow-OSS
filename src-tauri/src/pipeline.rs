use std::sync::Arc;
/// pipeline.rs — State management for the recording pipeline
/// The actual transcription logic is in lib.rs to avoid circular deps.
use tauri::{Emitter, State};

pub struct PipelineState {
    pub privacy_mode: std::sync::Mutex<bool>,
    pub is_processing: std::sync::Mutex<bool>,
    pub current_language: std::sync::Mutex<String>,
    /// When true, Devanagari (Hindi) output is romanized into Latin letters
    /// ("Hinglish") after transcription. When false, it stays in Devanagari.
    /// Off by default. Only meaningful for multilingual models (Large V3 Turbo).
    pub romanize: std::sync::Mutex<bool>,
    /// Languages the user speaks (Whisper codes). Auto-detect only chooses among
    /// these, so a short or noisy clip never comes back in some unrelated language.
    pub languages: std::sync::Mutex<Vec<String>>,
    pub is_command_mode: std::sync::Mutex<bool>,
    pub command_mode_text: std::sync::Mutex<String>,
}

impl PipelineState {
    pub fn new() -> Self {
        Self {
            privacy_mode: std::sync::Mutex::new(false),
            is_processing: std::sync::Mutex::new(false),
            current_language: std::sync::Mutex::new("auto".to_string()),
            romanize: std::sync::Mutex::new(false),
            languages: std::sync::Mutex::new(vec!["en".to_string(), "hi".to_string()]),
            is_command_mode: std::sync::Mutex::new(false),
            command_mode_text: std::sync::Mutex::new(String::new()),
        }
    }
}

#[tauri::command]
pub fn toggle_privacy_mode(app: tauri::AppHandle, pipeline: State<'_, Arc<PipelineState>>) -> bool {
    let new_value = {
        let mut mode = pipeline.privacy_mode.lock().unwrap();
        *mode = !*mode;
        *mode
    };
    // Broadcast so the sidebar, the bubble menu, and the tray all stay in sync.
    let _ = app.emit("privacy-changed", new_value);
    new_value
}

#[tauri::command]
pub fn get_privacy_mode(pipeline: State<'_, Arc<PipelineState>>) -> bool {
    *pipeline.privacy_mode.lock().unwrap()
}

#[tauri::command]
pub fn set_language(pipeline: State<'_, Arc<PipelineState>>, language: String) {
    *pipeline.current_language.lock().unwrap() = language;
}

/// Parse a stored "en,hi,ta" list into valid Whisper language codes.
pub fn parse_languages(field: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for code in field.split(',').map(|c| c.trim().to_lowercase()) {
        if !code.is_empty() && whisper_rs::get_lang_id(&code).is_some() && !out.contains(&code) {
            out.push(code);
        }
    }
    out
}

#[tauri::command]
pub fn set_languages(pipeline: State<'_, Arc<PipelineState>>, languages: Vec<String>) {
    let list = parse_languages(&languages.join(","));
    *pipeline.languages.lock().unwrap() = if list.is_empty() { vec!["en".to_string()] } else { list };
}

#[tauri::command]
pub fn set_romanize(pipeline: State<'_, Arc<PipelineState>>, romanize: bool) {
    *pipeline.romanize.lock().unwrap() = romanize;
}

#[tauri::command]
pub fn get_pipeline_status(pipeline: State<'_, Arc<PipelineState>>) -> serde_json::Value {
    serde_json::json!({
        "is_processing": *pipeline.is_processing.lock().unwrap(),
        "privacy_mode": *pipeline.privacy_mode.lock().unwrap(),
        "language": *pipeline.current_language.lock().unwrap(),
        "romanize": *pipeline.romanize.lock().unwrap(),
    })
}
