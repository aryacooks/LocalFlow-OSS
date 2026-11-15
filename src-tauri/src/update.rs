//! One-click updates. The app reads `latest.json` from the newest GitHub release
//! (endpoint and public key in tauri.conf.json → plugins.updater), downloads the
//! signed `.app.tar.gz`, checks its signature, swaps the app in place, and the
//! frontend relaunches it.
//!
//! This lives in Rust instead of the plugin's JS `check()` for one reason: the JS
//! side can't set a connect timeout. GitHub serves downloads from several servers,
//! and when one of them is unreachable from someone's network the request sat on
//! it for the OS's ~75 s TCP timeout, so the card showed "Checking…" for over a
//! minute. With a short connect timeout it moves on to the next server at once.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
pub struct UpdateStatus {
    /// Version running now.
    current: String,
    /// Newest published version (None if the check couldn't read it).
    latest: Option<String>,
    /// True when `latest` is newer than `current`.
    available: bool,
    notes: Option<String>,
}

fn updater(app: &AppHandle, seen: Arc<Mutex<Option<String>>>) -> Result<Updater, String> {
    app.updater_builder()
        .configure_client(|c| c.connect_timeout(Duration::from_secs(6)).read_timeout(Duration::from_secs(30)))
        // Remember the published version even when it isn't newer, so the card can
        // say "Latest 0.1.25 · you're up to date".
        .version_comparator(move |current, remote| {
            *seen.lock().unwrap() = Some(remote.version.to_string());
            remote.version > current
        })
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<UpdateStatus, String> {
    let current = app.package_info().version.to_string();
    let seen = Arc::new(Mutex::new(None));
    let found = updater(&app, seen.clone())?.check().await.map_err(|e| e.to_string())?;
    let latest = seen.lock().unwrap().clone();
    let status = UpdateStatus {
        current,
        latest: found.as_ref().map(|u| u.version.clone()).or(latest),
        available: found.is_some(),
        notes: found.as_ref().and_then(|u| u.body.clone()),
    };
    *pending.0.lock().unwrap() = found;
    Ok(status)
}

/// Downloads, verifies and installs the update found by the last `check_update`.
/// Emits `update-progress` as `(downloaded_bytes, total_bytes | null)`.
#[tauri::command]
pub async fn install_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().clone().ok_or("No update to install. Check again.")?;
    let mut downloaded: u64 = 0;
    let events = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = events.emit("update-progress", (downloaded, total));
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())
}
