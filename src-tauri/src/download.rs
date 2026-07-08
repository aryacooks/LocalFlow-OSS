//! Shared cancellation registry for long-running model/CLI downloads.
//!
//! Downloads stream chunks in `whisper::download_model` / `llm::download_llm_model`.
//! The frontend can ask to cancel an in-flight download by id; the download loop
//! checks `cancel_requested` between chunks and bails out, deleting its temp file.
//!
//! Ids match what the download loops emit on the `download-progress` event
//! (the model id, or "llama-cli" for the helper binary).

use once_cell::sync::Lazy;
use std::collections::HashSet;
use std::sync::Mutex;

static CANCELLED: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

/// Flag a download id for cancellation. The active loop notices on its next chunk.
pub fn mark_cancel(id: &str) {
    CANCELLED.lock().unwrap().insert(id.to_string());
}

/// True while a cancel has been requested for `id` and not yet cleared.
pub fn cancel_requested(id: &str) -> bool {
    CANCELLED.lock().unwrap().contains(id)
}

/// Drop any (possibly stale) cancel flag for `id` — call when starting or ending a download.
pub fn clear_cancel(id: &str) {
    CANCELLED.lock().unwrap().remove(id);
}

/// Frontend entry point: request cancellation of the download with this id.
#[tauri::command]
pub fn cancel_download(model_id: String) {
    mark_cancel(&model_id);
}
