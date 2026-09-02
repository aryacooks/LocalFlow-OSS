mod audio;
mod cleanup;
mod db;
mod download;
mod earcon;
#[cfg(windows)]
#[path = "hook_windows.rs"]
mod hook;
#[cfg(not(windows))]
#[path = "hook_macos.rs"]
mod hook;
mod inject;
mod llm;
mod mac_permissions;
mod pipeline;
mod translit;
mod whisper;

use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

use db::DbState;
use pipeline::PipelineState;

/// Shared sysinfo handle for cross-platform telemetry (non-Windows).
#[cfg(not(windows))]
static SYSINFO: once_cell::sync::Lazy<std::sync::Mutex<sysinfo::System>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(sysinfo::System::new_all()));

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let audio_state = Arc::new(audio::AudioState::new());
    let pipeline_state = Arc::new(PipelineState::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup({
            let audio_state = audio_state.clone();
            let pipeline_state = pipeline_state.clone();
            move |app| {
                // ── Database ────────────────────────────────────────────────
                let db_path = db::get_db_path(&app.handle()).expect("Failed to get DB path");
                let conn =
                    rusqlite::Connection::open(&db_path).expect("Failed to open SQLite database");
                db::init_db(&conn).expect("Failed to initialize database");
                app.manage(DbState(std::sync::Mutex::new(conn)));

                // Apply the saved "play sounds" preference before any earcon fires.
                if let Some(db_state) = app.try_state::<DbState>() {
                    let sounds = {
                        let conn = db_state.0.lock().unwrap();
                        conn.query_row(
                            "SELECT value FROM settings WHERE key = 'play_sounds'",
                            [],
                            |r| r.get::<_, String>(0),
                        )
                        .unwrap_or_else(|_| "true".to_string())
                    };
                    earcon::set_sounds_enabled(sounds != "false");
                }

                // Restore the preferred microphone before global shortcuts become
                // active. Without this, Settings saved the choice but every fresh
                // launch silently recorded from the system default device.
                if let Some(db_state) = app.try_state::<DbState>() {
                    let saved_mic = {
                        let conn = db_state.0.lock().unwrap();
                        conn.query_row(
                            "SELECT value FROM settings WHERE key = 'mic_device'",
                            [],
                            |r| r.get::<_, String>(0),
                        )
                        .unwrap_or_default()
                    };
                    if !saved_mic.is_empty() {
                        *audio_state.device_name.lock().unwrap() = saved_mic;
                    }
                }

                // Restore saved language + romanize choices into the live pipeline
                // state. These in-memory toggles default on launch, and the frontend
                // only re-applies them when specific routes mount (Models page for
                // romanize), so without this a fresh launch silently ignores the
                // user's saved preference until they revisit that page.
                if let Some(db_state) = app.try_state::<DbState>() {
                    let conn = db_state.0.lock().unwrap();
                    if let Ok(lang) = conn.query_row(
                        "SELECT value FROM settings WHERE key = 'language'",
                        [],
                        |r| r.get::<_, String>(0),
                    ) {
                        if !lang.is_empty() {
                            *pipeline_state.current_language.lock().unwrap() = lang;
                        }
                    }
                    if let Ok(rom) = conn.query_row(
                        "SELECT value FROM settings WHERE key = 'auto_romanize'",
                        [],
                        |r| r.get::<_, String>(0),
                    ) {
                        *pipeline_state.romanize.lock().unwrap() = rom != "false";
                    }
                }

                // Launch at login: enable it once on first run so the app starts
                // with the system by default. Gated on a flag so we never override a
                // user who later turns it off in Settings.
                {
                    use tauri_plugin_autostart::ManagerExt;
                    let already_set = app
                        .try_state::<DbState>()
                        .and_then(|db| {
                            let conn = db.0.lock().ok()?;
                            conn.query_row(
                                "SELECT value FROM settings WHERE key = 'autostart_initialized'",
                                [],
                                |r| r.get::<_, String>(0),
                            )
                            .ok()
                        })
                        .as_deref()
                        == Some("true");
                    if !already_set {
                        let _ = app.autolaunch().enable();
                        if let Some(db) = app.try_state::<DbState>() {
                            if let Ok(conn) = db.0.lock() {
                                let _ = conn.execute(
                                    "INSERT OR REPLACE INTO settings (key, value) VALUES ('autostart_initialized', 'true')",
                                    [],
                                );
                            }
                        }
                    }
                }

                // Initialize Windows low-level keyboard hook
                hook::init_hook(
                    app.handle().clone(),
                    audio_state.clone(),
                    pipeline_state.clone(),
                );
                // Show the bubble window on startup
                show_bubble_window(app.handle());

                // Intercept main window close to hide it instead of closing, keeping it in tray
                if let Some(main_win) = app.get_webview_window("main") {
                    size_main_window(&main_win);
                    let main_win_clone = main_win.clone();
                    main_win.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = main_win_clone.hide();
                        }
                    });
                }

                // ── Global shortcuts ────────────────────────────────────────
                if let Err(e) = register_global_toggle_shortcut(app.handle()) {
                    eprintln!("Failed to register initial global shortcut: {}", e);
                }

                // ── System Tray ─────────────────────────────────────────────
                let pipeline_tray = pipeline_state.clone();

                let open_item =
                    MenuItem::with_id(app, "open", "Open LocalFlow", true, None::<&str>)?;
                let privacy_item =
                    MenuItem::with_id(app, "privacy", "Incognito: OFF", true, None::<&str>)?;
                let quit_item =
                    MenuItem::with_id(app, "quit", "Quit LocalFlow", true, None::<&str>)?;

                let menu = Menu::with_items(app, &[&open_item, &privacy_item, &quit_item])?;
                let privacy_item_handle = privacy_item.clone();

                TrayIconBuilder::new()
                    .icon(app.default_window_icon().unwrap().clone())
                    .menu(&menu)
                    .on_menu_event(move |app, event| match event.id().as_ref() {
                        "open" => {
                            if let Some(win) = app.get_webview_window("main") {
                                win.show().ok();
                                win.set_focus().ok();
                            }
                        }
                        "privacy" => {
                            let new_value = {
                                let mut mode = pipeline_tray.privacy_mode.lock().unwrap();
                                *mode = !*mode;
                                *mode
                            };
                            let _ = privacy_item_handle.set_text(if new_value {
                                "Incognito: ON"
                            } else {
                                "Incognito: OFF"
                            });
                            let _ = app.emit("privacy-changed", new_value);
                            println!("Incognito: {}", new_value);
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(win) = app.get_webview_window("main") {
                                win.show().ok();
                                win.set_focus().ok();
                            }
                        }
                    })
                    .build(app)?;

                println!("LocalFlow initialized.");
                Ok(())
            }
        })
        .manage(audio_state.clone())
        .manage(pipeline_state.clone())
        .invoke_handler(tauri::generate_handler![
            // Audio
            audio::list_audio_devices,
            audio::start_audio_capture,
            audio::stop_audio_capture,
            audio::get_amplitude,
            audio::is_recording,
            audio::set_audio_device,
            // Whisper
            whisper::list_models,
            whisper::download_model,
            whisper::transcribe_audio,
            whisper::set_active_model,
            whisper::delete_model,
            // Downloads (shared cancel)
            download::cancel_download,
            // Database
            db::save_dictation,
            db::get_history,
            db::delete_history_entry,
            db::clear_history,
            db::get_dashboard_stats,
            db::get_dictionary,
            db::add_dictionary_entry,
            db::delete_dictionary_entry,
            db::get_dictionary_prompt,
            db::get_setting,
            db::set_setting,
            db::get_all_settings,
            db::get_notes,
            db::save_note,
            db::delete_note,
            // Cleanup
            cleanup::cleanup_text,
            cleanup::command_mode_transform,
            // LLM
            llm::list_llm_models,
            llm::is_llama_cli_installed,
            llm::download_llama_cli,
            llm::download_llm_model,
            llm::delete_llm_model,
            // Inject
            inject::inject_text,
            inject::inject_text_clipboard,
            inject::get_foreground_app,
            // macOS permissions (onboarding wizard)
            mac_permissions::get_permission_status,
            mac_permissions::request_accessibility_permission,
            mac_permissions::request_input_monitoring_permission,
            mac_permissions::request_microphone_permission,
            mac_permissions::open_privacy_settings,
            get_total_ram_mb,
            get_install_status,
            // Pipeline
            pipeline::toggle_privacy_mode,
            pipeline::get_privacy_mode,
            pipeline::set_language,
            pipeline::set_romanize,
            pipeline::get_pipeline_status,
            // Frontend-callable
            start_recording_cmd,
            set_bubble_visible,
            set_earcons_enabled,
            stop_and_transcribe_cmd,
            get_system_stats,
            reload_global_shortcut,
            quit_app,
            open_main_window,
            resize_bubble,
            set_bubble_size,
            get_bubble_position,
            nudge_bubble,
            reset_bubble_position,
        ])
        .build(tauri::generate_context!())
        .expect("error while running LocalFlow")
        .run(|_app_handle, _event| {
            // macOS: clicking the Dock icon while the window is hidden re-shows it.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                if let Some(win) = _app_handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        });
}
/// Logical (CSS-px) size of the idle bubble — just big enough for the logo plus a
/// little breathing room for the hover-enlarge. Kept tight so it doesn't intercept
/// clicks across the empty space to the left of the floating logo.
const BUBBLE_IDLE_W: f64 = 44.0;
const BUBBLE_IDLE_H: f64 = 44.0;

fn bubble_scale(monitor_size: tauri::PhysicalSize<u32>, scale_factor: f64) -> f64 {
    let logical_width = monitor_size.width as f64 / scale_factor;
    let logical_height = monitor_size.height as f64 / scale_factor;
    let shortest_edge = logical_width.min(logical_height);

    // A 14" 1080p-ish laptop was the original tuning target. Larger or denser
    // displays get a controlled bump so the floating affordance stays easy to hit.
    (shortest_edge / 900.0).clamp(1.0, 1.38)
}

/// Bounds for the manual bubble-size multiplier. 0.5 is genuinely tiny — a barely
/// visible dot — and 5.0 spans most of a laptop's width. The clamp exists so a
/// corrupt or hand-edited settings row cannot produce a bubble that is invisible or
/// larger than the screen; within the range the user is free to pick anything.
///
/// NOTE: these bounds and the step are mirrored in the frontend — `MicBubble.tsx`
/// (`bubbleSizeToScale`) and `Settings.tsx` (the stepper). Keep them in sync: the
/// window size is computed here and the content size there, and a mismatch makes
/// the logo the wrong size for its window.
pub const BUBBLE_SCALE_MIN: f64 = 0.5;
pub const BUBBLE_SCALE_MAX: f64 = 5.0;

/// Parse the user's manual bubble-size setting into a scale multiplier that
/// overrides the auto-detected `bubble_scale`. Returns `None` for "auto", an empty
/// value, or anything unparseable, so callers fall back to the geometry heuristic.
fn bubble_size_to_scale(size: &str) -> Option<f64> {
    let raw: f64 = size.trim().parse().ok()?;
    if !raw.is_finite() {
        return None;
    }
    Some(raw.clamp(BUBBLE_SCALE_MIN, BUBBLE_SCALE_MAX))
}

/// Read the user's manual bubble-size override from settings, if any is set.
fn user_scale_override(app: &tauri::AppHandle) -> Option<f64> {
    let db = app.try_state::<DbState>()?;
    let conn = db.0.lock().ok()?;
    let val: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'bubble_size'",
            [],
            |row| row.get(0),
        )
        .ok()?;
    bubble_size_to_scale(&val)
}

/// Read the user's custom bubble position, stored as `"fx,fy"` — a fraction (0..1) of
/// the available work-area span for the window's top-left corner. `None` means the
/// user hasn't moved it, so the default bottom-right anchor is used.
fn saved_bubble_pos(app: &tauri::AppHandle) -> Option<(f64, f64)> {
    let db = app.try_state::<DbState>()?;
    let conn = db.0.lock().ok()?;
    let val: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'bubble_pos'",
            [],
            |row| row.get(0),
        )
        .ok()?;
    let mut parts = val.split(',');
    let fx: f64 = parts.next()?.trim().parse().ok()?;
    let fy: f64 = parts.next()?.trim().parse().ok()?;
    if fx.is_finite() && fy.is_finite() {
        Some((fx.clamp(0.0, 1.0), fy.clamp(0.0, 1.0)))
    } else {
        None
    }
}

/// Size the bubble window to the given logical (CSS-px) dimensions and pin its
/// bottom-right corner just inside the active monitor's **work area** — the region
/// that excludes the macOS Dock + menu bar (and the Windows taskbar). Anchoring to the
/// work area instead of the full display keeps the bubble from hiding behind the Dock:
/// a normal always-on-top window sits *below* the macOS Dock. The window is always
/// right-anchored, so changing the width only moves the LEFT edge — the logo never
/// shifts on screen.
fn place_bubble(b: &tauri::WebviewWindow, logical_w: f64, logical_h: f64) {
    if let Ok(Some(monitor)) = b.current_monitor() {
        let monitor_size = monitor.size();
        let scale_factor = monitor.scale_factor();

        // Bubble sizing is unaffected by the Dock/taskbar, so it keys off the FULL
        // display size. A manual screen-size override (Settings) wins; otherwise fall
        // back to the geometry-based heuristic.
        let base_scale = user_scale_override(b.app_handle())
            .unwrap_or_else(|| bubble_scale(*monitor_size, scale_factor));
        let adaptive_scale = scale_factor * base_scale;

        let width = (logical_w * adaptive_scale).round() as u32;
        let height = (logical_h * adaptive_scale).round() as u32;

        // Anchor to the work area. Fall back to the full monitor rect if the work area
        // is unavailable or reports a zero size (older platforms / edge cases).
        let wa = monitor.work_area();
        let (area_x, area_y, area_w, area_h) = if wa.size.width > 0 && wa.size.height > 0 {
            (wa.position.x, wa.position.y, wa.size.width, wa.size.height)
        } else {
            let p = monitor.position();
            (p.x, p.y, monitor_size.width, monitor_size.height)
        };

        // The user can move the bubble anywhere via Settings → Bubble position. We store
        // that as a fraction (0..1) of the available work-area span for the window's
        // top-left corner, so it survives resolution and size changes. With no custom
        // position, fall back to the default bottom-right anchor.
        let avail_w = (area_w as i32 - width as i32).max(0);
        let avail_h = (area_h as i32 - height as i32).max(0);
        let (x, y) = if let Some((fx, fy)) = saved_bubble_pos(b.app_handle()) {
            (
                area_x + (fx * avail_w as f64).round() as i32,
                area_y + (fy * avail_h as f64).round() as i32,
            )
        } else {
            // Keep the side gap; the work area already excludes the Dock, so the bottom gap
            // is just a small breather (don't re-add the old taskbar-sized 72px margin).
            let margin_x = (28.0 * adaptive_scale).round() as i32;
            let margin_y = (12.0 * adaptive_scale).round() as i32;
            (
                area_x + area_w as i32 - width as i32 - margin_x,
                area_y + area_h as i32 - height as i32 - margin_y,
            )
        };

        let _ = b.set_size(tauri::Size::Physical(tauri::PhysicalSize { width, height }));
        let _ = b.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
    }
}

/// Whether the user has hidden the floating bubble (Settings → Display).
fn bubble_hidden(app: &tauri::AppHandle) -> bool {
    app.try_state::<DbState>()
        .map(|db| {
            let conn = db.0.lock().unwrap();
            conn.query_row(
                "SELECT value FROM settings WHERE key = 'show_bubble'",
                [],
                |r| r.get::<_, String>(0),
            )
            .map(|v| v == "false")
            .unwrap_or(false)
        })
        .unwrap_or(false)
}

/// Position and show the compact bubble window at the bottom right of the active monitor.
/// Respects the user's "hide bubble" preference — stays hidden even during recording.
pub fn show_bubble_window(app: &tauri::AppHandle) {
    if let Some(b) = app.get_webview_window("bubble") {
        if bubble_hidden(app) {
            let _ = b.hide();
            return;
        }
        // Critical: the bubble must NEVER take keyboard focus. Showing a focusable
        // window calls makeKeyAndOrderFront on macOS, which steals focus from the text
        // field you're dictating into (the caret vanishes, paste lands nowhere). Marking
        // it non-focusable makes show() just order it front without becoming key.
        let _ = b.set_focusable(false);
        place_bubble(&b, BUBBLE_IDLE_W, BUBBLE_IDLE_H);
        let _ = b.show();
        let _ = b.set_always_on_top(true);
    }
}

fn size_main_window(win: &tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = win.current_monitor() {
        let monitor_size = monitor.size();
        let monitor_pos = monitor.position();
        let scale_factor = monitor.scale_factor();
        let logical_width = monitor_size.width as f64 / scale_factor;
        let logical_height = monitor_size.height as f64 / scale_factor;

        let target_logical_width = (logical_width * 0.84).clamp(1100.0, 1360.0);
        let target_logical_height = (logical_height * 0.84).clamp(720.0, 900.0);
        let width = (target_logical_width * scale_factor).round() as u32;
        let height = (target_logical_height * scale_factor).round() as u32;

        let x = monitor_pos.x + ((monitor_size.width as i32 - width as i32) / 2).max(0);
        let y = monitor_pos.y + ((monitor_size.height as i32 - height as i32) / 2).max(0);

        let _ = win.set_size(tauri::Size::Physical(tauri::PhysicalSize { width, height }));
        let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
    }
}

/// Sets `is_processing = true` on creation and guarantees it returns to `false` on drop —
/// including via an early `return` or a panic anywhere in `run_pipeline`. Without this, a
/// failure mid-pipeline would leave the flag stuck `true`, which blocks the next toggle
/// from *both* the keyboard and mouse hooks (they all gate on `!is_processing`). Recovers
/// from a poisoned lock so the reset can never itself panic.
struct ProcessingGuard(Arc<PipelineState>);

impl ProcessingGuard {
    fn new(pipeline: &Arc<PipelineState>) -> Self {
        *pipeline
            .is_processing
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
        Self(pipeline.clone())
    }
}

impl Drop for ProcessingGuard {
    fn drop(&mut self) {
        *self
            .0
            .is_processing
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = false;
    }
}

/// Run the STT pipeline after recording stops
pub async fn run_pipeline(
    app: &tauri::AppHandle,
    audio: &Arc<audio::AudioState>,
    pipeline: &Arc<PipelineState>,
) {
    use whisper_rs::{FullParams, SamplingStrategy};

    // Held for the whole function: clears `is_processing` on every exit path (return or
    // panic), so the flag can never get stuck and lock out the next dictation toggle.
    let _processing = ProcessingGuard::new(pipeline);
    app.emit("recording-stopped", ()).ok();
    app.emit("processing-started", ()).ok();

    let capture_rate = *audio.sample_rate.lock().unwrap();
    let audio_data: Vec<f32> = {
        let mut buf = audio.buffer.lock().unwrap();
        if buf.is_empty() {
            app.emit("processing-done", serde_json::json!({"error": "No audio"}))
                .ok();
            return;
        }
        let samples = buf.drain(..).collect();
        // `drain` empties the deque but keeps its capacity, which for a long recording is
        // ~115 MB. Hand it back rather than holding it for the rest of the session — the
        // next recording reserves what it needs again.
        buf.shrink_to_fit();
        samples
    };

    // Resample captured audio to 16 kHz mono for Whisper (mics often run at 44.1/48 kHz).
    let audio_data = audio::resample_to_16k(audio_data, capture_rate);
    let duration_secs = audio_data.len() as f64 / audio::SAMPLE_RATE as f64;

    // Silence gate: bail on near-silent or too-short clips (hotkey tapped with no speech,
    // long silent lead-in). On silence Whisper hallucinates subtitle filler like
    // "(Clapping)"/"(Upbeat music)"/"[BLANK_AUDIO]" — skipping it avoids that entirely.
    let rms = if audio_data.is_empty() {
        0.0
    } else {
        (audio_data.iter().map(|s| s * s).sum::<f32>() / audio_data.len() as f32).sqrt()
    };
    if rms < 0.005 || audio_data.len() < audio::SAMPLE_RATE as usize / 2 {
        app.emit(
            "processing-done",
            serde_json::json!({"error": "No speech detected"}),
        )
        .ok();
        return;
    }

    let (app_name, app_exe) = inject::get_foreground_app();

    // Get dictionary prompt from DB
    let dict_prompt = {
        if let Some(db_state) = app.try_state::<DbState>() {
            let conn = db_state.0.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT term FROM dictionary ORDER BY term ASC")
                .unwrap_or_else(|_| conn.prepare("SELECT 1 WHERE 0").unwrap());
            let terms: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default();
            if terms.is_empty() {
                String::new()
            } else {
                format!("Vocabulary: {}. ", terms.join(", "))
            }
        } else {
            String::new()
        }
    };

    let language = pipeline.current_language.lock().unwrap().clone();
    let romanize = *pipeline.romanize.lock().unwrap();

    let model_path = match whisper::get_active_model_path(app) {
        Ok(p) => p,
        Err(e) => {
            app.emit("processing-done", serde_json::json!({"error": e}))
                .ok();
            return;
        }
    };

    if !model_path.exists() {
        app.emit(
            "processing-done",
            serde_json::json!({"error": "Model not downloaded. Go to Models page."}),
        )
        .ok();
        return;
    }

    // Guard against corrupt/partial model files (e.g. a saved 404 error body).
    if std::fs::metadata(&model_path).map(|m| m.len()).unwrap_or(0) < 1_000_000 {
        app.emit(
            "processing-done",
            serde_json::json!({"error": "Model file is corrupt or incomplete. Delete and re-download it on the Models page."}),
        )
        .ok();
        return;
    }

    let model_str = model_path.to_str().unwrap_or("").to_string();
    let lang = language.clone();
    let prompt = dict_prompt.clone();
    let multilingual = whisper::is_multilingual_model(&model_str);

    let raw_text = tauri::async_runtime::spawn_blocking(move || {
        // Reuses the already-loaded model; only the first dictation after a launch or a
        // model switch pays the disk read.
        let ctx = whisper::context_for(&model_str)?;
        let mut state = ctx
            .create_state()
            .map_err(|e| format!("Whisper state: {}", e))?;
        // Constrain to English/Hindi only (auto picks the higher-scoring of the two).
        let chosen_lang = whisper::resolve_language(&mut state, &audio_data, &lang, multilingual);
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(&chosen_lang));
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);
        // Non-speech suppression + the anti-repetition guards, shared with `transcribe`.
        whisper::apply_decoder_guards(&mut params);
        if !prompt.is_empty() {
            params.set_initial_prompt(&prompt);
        }
        state.full(params, &audio_data).map_err(|e| e.to_string())?;
        let n = state.full_n_segments();
        let mut text = String::new();
        for i in 0..n {
            if let Some(segment) = state.get_segment(i) {
                if let Ok(seg) = segment.to_str() {
                    text.push_str(seg);
                }
            }
        }
        Ok::<String, String>(whisper::strip_non_speech(&whisper::collapse_repetitions(
            &text,
        )))
    })
    .await;

    let raw = match raw_text {
        // Romanize Devanagari → Latin ("Hinglish") when the toggle is on. No-op for
        // English/other Latin output, so it's safe to apply unconditionally here.
        Ok(Ok(t)) => {
            if romanize {
                translit::devanagari_to_latin(&t)
            } else {
                t
            }
        }
        Ok(Err(e)) => {
            let msg = format!("Transcription error: {}", e);
            eprintln!("{}", msg);
            app.emit("processing-done", serde_json::json!({"error": msg}))
                .ok();
            return;
        }
        Err(e) => {
            let msg = format!("Task join error: {}", e);
            eprintln!("{}", msg);
            app.emit("processing-done", serde_json::json!({"error": msg}))
                .ok();
            return;
        }
    };

    if raw.is_empty() {
        app.emit(
            "processing-done",
            serde_json::json!({"error": "No speech detected"}),
        )
        .ok();
        return;
    }

    let cleaned = match cleanup::cleanup_text(app.clone(), raw.clone(), app_exe.clone()) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("Cleanup error: {}, falling back to regex", e);
            cleanup::regex_cleanup(&raw)
        }
    };

    let is_cmd = {
        let mut cmd = pipeline.is_command_mode.lock().unwrap();
        let was_cmd = *cmd;
        *cmd = false; // Reset command mode
        was_cmd
    };

    let text_to_inject = if is_cmd {
        let selected = {
            let mut txt = pipeline.command_mode_text.lock().unwrap();
            let val = txt.clone();
            *txt = String::new(); // Reset
            val
        };
        match cleanup::command_mode_transform(
            app.clone(),
            selected,
            cleaned.clone(),
            app_exe.clone(),
        ) {
            Ok(transformed) => transformed,
            Err(e) => {
                eprintln!("Command transform failed: {}", e);
                cleaned.clone()
            }
        }
    } else {
        cleaned.clone()
    };

    let word_count = text_to_inject.split_whitespace().count() as i64;

    // Save to DB
    let privacy = *pipeline.privacy_mode.lock().unwrap();
    if !privacy {
        if let Some(db_state) = app.try_state::<DbState>() {
            let conn = db_state.0.lock().unwrap();
            let save_history: String = conn
                .query_row(
                    "SELECT value FROM settings WHERE key = 'save_history'",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or_else(|_| "true".to_string());

            let track_apps: String = conn
                .query_row(
                    "SELECT value FROM settings WHERE key = 'track_apps'",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or_else(|_| "true".to_string());

            let (final_app_name, final_app_exe) = if track_apps == "false" {
                ("".to_string(), "".to_string())
            } else {
                (app_name.clone(), app_exe.clone())
            };

            let (final_raw, final_cleaned) = if save_history == "false" {
                (String::new(), String::new())
            } else {
                (raw.clone(), text_to_inject.clone())
            };

            let _ = conn.execute(
                "INSERT INTO dictation_history (app_name, app_exe, raw_text, cleaned_text, word_count, duration_secs, language) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![final_app_name, final_app_exe, final_raw, final_cleaned, word_count, duration_secs, language],
            );
        }
    }

    app.emit(
        "processing-done",
        serde_json::json!({
            "raw": raw,
            "cleaned": text_to_inject,
            "word_count": word_count,
            "app_name": app_name,
        }),
    )
    .ok();

    // Inject
    if let Err(e) = inject::inject_text_clipboard(text_to_inject).await {
        eprintln!("Injection failed: {}", e);
    }

    app.emit("recording-stopped", ()).ok();
}

/// Shared recording helpers used by the platform input hooks (e.g. the macOS mouse
/// event tap in hook_macos.rs). On macOS these touch windows, so callers should invoke
/// them on the main thread (via `run_on_main_thread`).
pub(crate) fn hook_start_recording(app: &tauri::AppHandle, audio: &Arc<audio::AudioState>) {
    if *audio.is_recording.lock().unwrap() {
        return;
    }
    let device = audio.device_name.lock().unwrap().clone();
    let dev_opt = if device.is_empty() {
        None
    } else {
        Some(device)
    };
    if let Err(e) = crate::audio::start_capture_internal(audio, dev_opt) {
        eprintln!("Hook: failed to start recording: {}", e);
        return;
    }
    crate::earcon::play_start_sound();
    app.emit("recording-started", ()).ok();
    show_bubble_window(app);
}

pub(crate) fn hook_stop_and_transcribe(
    app: &tauri::AppHandle,
    audio: &Arc<audio::AudioState>,
    pipeline: &Arc<PipelineState>,
) {
    if !*audio.is_recording.lock().unwrap() {
        return;
    }
    crate::earcon::play_stop_sound();
    let ah = app.clone();
    let audio_h = audio.clone();
    let pipeline_h = pipeline.clone();
    tauri::async_runtime::spawn(async move {
        crate::audio::stop_capture_internal(&audio_h);
        run_pipeline(&ah, &audio_h, &pipeline_h).await;
    });
}

pub(crate) fn hook_toggle_recording(
    app: &tauri::AppHandle,
    audio: &Arc<audio::AudioState>,
    pipeline: &Arc<PipelineState>,
) {
    if *pipeline.is_processing.lock().unwrap() {
        return;
    }
    if *audio.is_recording.lock().unwrap() {
        hook_stop_and_transcribe(app, audio, pipeline);
    } else {
        hook_start_recording(app, audio);
    }
}

/// Frontend button: start recording
#[tauri::command]
async fn start_recording_cmd(
    audio: tauri::State<'_, Arc<audio::AudioState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if *audio.is_recording.lock().unwrap() {
        return Ok(());
    }
    let device = audio.device_name.lock().unwrap().clone();
    let dev_opt = if device.is_empty() {
        None
    } else {
        Some(device)
    };
    audio::start_capture_internal(audio.inner(), dev_opt)?;
    crate::earcon::play_start_sound();
    app.emit("recording-started", ()).ok();
    show_bubble_window(&app);
    Ok(())
}

/// Frontend button: stop recording and transcribe
#[tauri::command]
async fn stop_and_transcribe_cmd(
    audio: tauri::State<'_, Arc<audio::AudioState>>,
    pipeline: tauri::State<'_, Arc<PipelineState>>,
    _db: tauri::State<'_, DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    if !*audio.is_recording.lock().unwrap() {
        return Ok(serde_json::json!({"status": "not_recording"}));
    }
    crate::earcon::play_stop_sound();
    audio::stop_capture_internal(audio.inner());

    let audio_arc = audio.inner().clone();
    let pipeline_arc = pipeline.inner().clone();
    run_pipeline(&app, &audio_arc, &pipeline_arc).await;

    Ok(serde_json::json!({"status": "done"}))
}

/// Total physical RAM in MB. Used by the onboarding wizard to recommend a Whisper
/// model the machine can comfortably run.
#[tauri::command]
fn get_total_ram_mb() -> u64 {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.total_memory() / (1024 * 1024)
}

#[derive(Debug, serde::Serialize)]
struct InstallStatus {
    is_macos: bool,
    running_from_disk_image: bool,
    app_translocated: bool,
    needs_move_to_applications: bool,
}

/// Detect install locations that commonly break first-run permissions or launch-at-login.
/// Development builds are deliberately excluded from the Applications-folder warning.
#[tauri::command]
fn get_install_status() -> InstallStatus {
    let exe = std::env::current_exe().unwrap_or_default();
    let path = exe.to_string_lossy();
    let is_macos = cfg!(target_os = "macos");
    let running_from_disk_image = is_macos && path.starts_with("/Volumes/");
    let app_translocated = is_macos && path.contains("/AppTranslocation/");
    let development_build = path.contains("/target/debug/") || path.contains("/target/release/");
    let installed_in_applications = path.contains("/Applications/");

    InstallStatus {
        is_macos,
        running_from_disk_image,
        app_translocated,
        needs_move_to_applications: is_macos && !development_build && !installed_in_applications,
    }
}

#[derive(Debug, serde::Serialize)]
pub struct SystemStats {
    pub process_cpu: f64,
    pub process_memory_mb: f64,
    pub system_cpu: f64,
    pub system_memory_pct: f64,
    pub estimated_power_watts: f64,
    pub app_state: String,
}

#[tauri::command]
async fn get_system_stats(
    audio: tauri::State<'_, Arc<audio::AudioState>>,
    pipeline: tauri::State<'_, Arc<pipeline::PipelineState>>,
) -> Result<SystemStats, String> {
    // 1. Get process memory info on Windows
    let memory_mb = {
        #[cfg(windows)]
        {
            use windows::Win32::System::ProcessStatus::{
                GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
            };
            use windows::Win32::System::Threading::GetCurrentProcess;
            unsafe {
                let handle = GetCurrentProcess();
                let mut counters = PROCESS_MEMORY_COUNTERS::default();
                if GetProcessMemoryInfo(
                    handle,
                    &mut counters,
                    std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
                )
                .is_ok()
                {
                    (counters.WorkingSetSize as f64) / 1024.0 / 1024.0
                } else {
                    0.0
                }
            }
        }
        #[cfg(not(windows))]
        {
            use sysinfo::{Pid, ProcessesToUpdate};
            let mut sys = SYSINFO.lock().unwrap();
            let pid = Pid::from_u32(std::process::id());
            sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
            sys.process(pid)
                .map(|p| p.memory() as f64 / 1024.0 / 1024.0)
                .unwrap_or(0.0)
        }
    };

    // 2. Get system memory info
    let sys_memory_pct = {
        #[cfg(windows)]
        {
            use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
            unsafe {
                let mut status = MEMORYSTATUSEX::default();
                status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
                if GlobalMemoryStatusEx(&mut status).is_ok() {
                    status.dwMemoryLoad as f64
                } else {
                    0.0
                }
            }
        }
        #[cfg(not(windows))]
        {
            let mut sys = SYSINFO.lock().unwrap();
            sys.refresh_memory();
            let total = sys.total_memory() as f64;
            if total > 0.0 {
                (sys.used_memory() as f64 / total) * 100.0
            } else {
                0.0
            }
        }
    };

    // 3. System CPU and process CPU delta calculation
    use once_cell::sync::Lazy;
    use std::sync::Mutex;
    use std::time::Instant;

    struct LastCpuSample {
        last_time: Instant,
        last_idle: u64,
        last_kernel: u64,
        last_user: u64,
        last_process_kernel: u64,
        last_process_user: u64,
        last_result_sys: f64,
        last_result_proc: f64,
    }

    static LAST_CPU: Lazy<Mutex<LastCpuSample>> = Lazy::new(|| {
        Mutex::new(LastCpuSample {
            last_time: Instant::now(),
            last_idle: 0,
            last_kernel: 0,
            last_user: 0,
            last_process_kernel: 0,
            last_process_user: 0,
            last_result_sys: 5.0,
            last_result_proc: 1.0,
        })
    });

    let mut cache = LAST_CPU.lock().unwrap();
    let now = Instant::now();
    let elapsed = now.duration_since(cache.last_time);

    if elapsed.as_millis() > 500 {
        #[cfg(windows)]
        {
            use windows::Win32::Foundation::FILETIME;
            use windows::Win32::System::Threading::{
                GetCurrentProcess, GetProcessTimes, GetSystemTimes,
            };

            unsafe {
                let mut idle = FILETIME::default();
                let mut kernel = FILETIME::default();
                let mut user = FILETIME::default();

                let mut proc_creation = FILETIME::default();
                let mut proc_exit = FILETIME::default();
                let mut proc_kernel = FILETIME::default();
                let mut proc_user = FILETIME::default();

                let sys_ok =
                    GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)).is_ok();
                let proc_ok = GetProcessTimes(
                    GetCurrentProcess(),
                    &mut proc_creation,
                    &mut proc_exit,
                    &mut proc_kernel,
                    &mut proc_user,
                )
                .is_ok();

                if sys_ok && proc_ok {
                    let to_u64 = |ft: FILETIME| -> u64 {
                        ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64)
                    };

                    let idle_val = to_u64(idle);
                    let kernel_val = to_u64(kernel);
                    let user_val = to_u64(user);

                    let proc_kernel_val = to_u64(proc_kernel);
                    let proc_user_val = to_u64(proc_user);

                    let idle_diff = idle_val.saturating_sub(cache.last_idle);
                    let kernel_diff = kernel_val.saturating_sub(cache.last_kernel);
                    let user_diff = user_val.saturating_sub(cache.last_user);

                    let proc_kernel_diff =
                        proc_kernel_val.saturating_sub(cache.last_process_kernel);
                    let proc_user_diff = proc_user_val.saturating_sub(cache.last_process_user);

                    let total_sys = kernel_diff + user_diff;
                    if total_sys > 0 {
                        let sys_cpu = (1.0 - (idle_diff as f64 / total_sys as f64)) * 100.0;
                        cache.last_result_sys = sys_cpu.clamp(0.0, 100.0);

                        let proc_cpu =
                            ((proc_kernel_diff + proc_user_diff) as f64 / total_sys as f64) * 100.0;
                        cache.last_result_proc = proc_cpu.clamp(0.0, 100.0);
                    }

                    cache.last_idle = idle_val;
                    cache.last_kernel = kernel_val;
                    cache.last_user = user_val;
                    cache.last_process_kernel = proc_kernel_val;
                    cache.last_process_user = proc_user_val;
                }
            }
        }
        #[cfg(not(windows))]
        {
            use sysinfo::Pid;
            let mut sys = SYSINFO.lock().unwrap();
            sys.refresh_cpu_all();
            cache.last_result_sys = (sys.global_cpu_usage() as f64).clamp(0.0, 100.0);

            // Process CPU was already refreshed in the memory step above; reading it
            // here (without re-refreshing) gives a real delta since the last poll.
            let pid = Pid::from_u32(std::process::id());
            let cores = sys.cpus().len().max(1) as f64;
            if let Some(p) = sys.process(pid) {
                // sysinfo reports process CPU relative to a single core; normalize
                // to whole-machine percent to match the Windows code path.
                cache.last_result_proc = ((p.cpu_usage() as f64) / cores).clamp(0.0, 100.0);
            }
        }
        cache.last_time = now;
    }

    let system_cpu = cache.last_result_sys;
    let process_cpu = cache.last_result_proc;

    // 4. App state & estimated power
    let is_rec = *audio.is_recording.lock().unwrap();
    let is_proc = *pipeline.is_processing.lock().unwrap();

    let (app_state, estimated_power_watts) = if is_proc {
        ("Transcribing".to_string(), 14.5)
    } else if is_rec {
        ("Recording".to_string(), 1.8)
    } else {
        ("Idle".to_string(), 0.1)
    };

    Ok(SystemStats {
        process_cpu,
        process_memory_mb: memory_mb,
        system_cpu,
        system_memory_pct: sys_memory_pct,
        estimated_power_watts,
        app_state,
    })
}

pub fn register_global_toggle_shortcut(app: &tauri::AppHandle) -> Result<(), String> {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

    // Keep the macOS mouse-tap's in-memory bind cache in sync with the DB on every
    // reload (the frontend calls reload_global_shortcut after changing a mouse trigger).
    #[cfg(not(windows))]
    crate::hook::refresh_mouse_binds(app);

    let global_sc = app.global_shortcut();

    // Unregister all first to clear previous toggle triggers
    let _ = global_sc.unregister_all();

    // Get the shortcut string from database
    let shortcut_str = if let Some(db_state) = app.try_state::<crate::db::DbState>() {
        let conn = db_state.0.lock().unwrap();
        conn.query_row(
            "SELECT value FROM settings WHERE key = 'shortcut_toggle'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "Alt+F".to_string())
    } else {
        "Alt+F".to_string()
    };

    let shortcut = Shortcut::from_str(&shortcut_str)
        .or_else(|_| Shortcut::from_str("Alt+F"))
        .map_err(|e| format!("Failed to parse global shortcut: {}", e))?;

    static TOGGLE_SHORTCUT_HELD: std::sync::Mutex<bool> = std::sync::Mutex::new(false);

    global_sc
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state() == ShortcutState::Released {
                if let Ok(mut held) = TOGGLE_SHORTCUT_HELD.lock() {
                    *held = false;
                }
                return;
            }

            if event.state() == ShortcutState::Pressed {
                if let Ok(mut held) = TOGGLE_SHORTCUT_HELD.lock() {
                    if *held {
                        return; // Ignore Windows key-repeat
                    }
                    *held = true;
                }
            }

            let audio = app.state::<Arc<crate::audio::AudioState>>();
            let pipeline = app.state::<Arc<crate::pipeline::PipelineState>>();

            let is_rec = *audio.is_recording.lock().unwrap();
            let is_proc = *pipeline.is_processing.lock().unwrap();

            if is_proc {
                return;
            }

            if is_rec {
                let ah = app.clone();
                let audio_h = audio.inner().clone();
                let pipeline_h = pipeline.inner().clone();
                crate::earcon::play_stop_sound();
                tauri::async_runtime::spawn(async move {
                    crate::audio::stop_capture_internal(&audio_h);
                    crate::run_pipeline(&ah, &audio_h, &pipeline_h).await;
                });
            } else {
                let device = audio.device_name.lock().unwrap().clone();
                let dev_opt = if device.is_empty() {
                    None
                } else {
                    Some(device)
                };
                if let Err(e) = crate::audio::start_capture_internal(audio.inner(), dev_opt) {
                    eprintln!("Global Shortcut: failed to start recording: {}", e);
                    return;
                }
                crate::earcon::play_start_sound();
                app.emit("recording-started", ()).ok();
                crate::show_bubble_window(app);
            }
        })
        .map_err(|e| e.to_string())?;

    // ── Non-Windows (macOS): hold-to-talk via the same plugin (Pressed/Released). ──
    // On Windows, hold-to-talk is handled by the native low-level keyboard hook;
    // macOS has no such hook (rdev crashes), so we use the global-shortcut plugin.
    #[cfg(not(windows))]
    {
        let hold_str = if let Some(db_state) = app.try_state::<crate::db::DbState>() {
            let conn = db_state.0.lock().unwrap();
            conn.query_row(
                "SELECT value FROM settings WHERE key = 'keybind_keyboard_name'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_else(|_| "Alt+C".to_string())
        } else {
            "Alt+C".to_string()
        };

        // Parse the hold combo, falling back to a known-good default if the stored
        // value is empty or a legacy/invalid accelerator (older builds saved friendly
        // names like "Right Alt" here, which don't parse). Previously a parse failure
        // or collision silently skipped registration → hold-to-talk did nothing.
        let hold_parsed = Shortcut::from_str(&hold_str).or_else(|_| Shortcut::from_str("Alt+C"));

        match hold_parsed {
            Err(e) => {
                eprintln!("Hold-to-talk: could not parse '{}': {}", hold_str, e);
            }
            // Skip if the hold combo collides with the toggle combo.
            Ok(_) if hold_str == shortcut_str => {
                eprintln!(
                    "Hold-to-talk: instant key '{}' matches the toggle key; pick a different Instant Dictation key.",
                    hold_str
                );
            }
            Ok(hold_shortcut) => {
                if let Err(e) =
                    global_sc.on_shortcut(hold_shortcut, move |app, _shortcut, event| {
                        let audio = app.state::<Arc<crate::audio::AudioState>>();
                        let pipeline = app.state::<Arc<crate::pipeline::PipelineState>>();
                        let is_proc = *pipeline.is_processing.lock().unwrap();

                        if event.state() == ShortcutState::Pressed {
                            if is_proc || *audio.is_recording.lock().unwrap() {
                                return;
                            }
                            let device = audio.device_name.lock().unwrap().clone();
                            let dev_opt = if device.is_empty() {
                                None
                            } else {
                                Some(device)
                            };
                            if let Err(e) =
                                crate::audio::start_capture_internal(audio.inner(), dev_opt)
                            {
                                eprintln!("Hold-to-talk: failed to start recording: {}", e);
                                return;
                            }
                            crate::earcon::play_start_sound();
                            app.emit("recording-started", ()).ok();
                            crate::show_bubble_window(app);
                        } else if event.state() == ShortcutState::Released {
                            if !*audio.is_recording.lock().unwrap() {
                                return;
                            }
                            crate::earcon::play_stop_sound();
                            let ah = app.clone();
                            let audio_h = audio.inner().clone();
                            let pipeline_h = pipeline.inner().clone();
                            tauri::async_runtime::spawn(async move {
                                crate::audio::stop_capture_internal(&audio_h);
                                crate::run_pipeline(&ah, &audio_h, &pipeline_h).await;
                            });
                        }
                    })
                {
                    eprintln!("Hold-to-talk: failed to register '{}': {}", hold_str, e);
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
async fn reload_global_shortcut(app: tauri::AppHandle) -> Result<(), String> {
    // Global hot-key (un)registration must run on the main thread on macOS (Carbon),
    // but Tauri runs async commands on a worker thread — so dispatch to the main thread.
    let app2 = app.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(register_global_toggle_shortcut(&app2));
    })
    .map_err(|e| format!("run_on_main_thread failed: {}", e))?;
    rx.recv()
        .map_err(|e| format!("main-thread result channel closed: {}", e))?
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn open_main_window(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        win.show().ok();
        win.set_focus().ok();
    }
}

/// Resize the bubble window to fit the currently visible UI (driven by the React
/// MicBubble as its state changes). Logical CSS-px dimensions; bottom-right anchored.
#[tauri::command]
fn resize_bubble(app: tauri::AppHandle, width: f64, height: f64) {
    // Don't resurrect a hidden bubble when the React side reports a state change.
    if bubble_hidden(&app) {
        return;
    }
    if let Some(b) = app.get_webview_window("bubble") {
        place_bubble(&b, width, height);
    }
}

/// Show or hide the floating bubble window (Settings → Display toggle).
#[tauri::command]
fn set_bubble_visible(app: tauri::AppHandle, visible: bool) {
    if let Some(b) = app.get_webview_window("bubble") {
        if visible {
            let _ = b.set_focusable(false); // never steal focus from the dictation target
            place_bubble(&b, BUBBLE_IDLE_W, BUBBLE_IDLE_H);
            let _ = b.show();
            let _ = b.set_always_on_top(true);
        } else {
            let _ = b.hide();
        }
    }
}

/// Enable or disable the UI beeps (Settings → Display toggle).
#[tauri::command]
fn set_earcons_enabled(enabled: bool) {
    crate::earcon::set_sounds_enabled(enabled);
}

/// Persist the user's manual bubble size — either "auto" or a scale multiplier such
/// as "1.4" — and immediately re-place the bubble so the change is visible without
/// waiting for the next recording. Emits `bubble-size-changed` so the bubble webview
/// updates its content scale (`uiScale`) in lock-step with the window size.
///
/// The stored value is normalised here rather than trusted from the frontend, so the
/// clamp holds no matter who calls this.
#[tauri::command]
fn set_bubble_size(app: tauri::AppHandle, size: String) -> Result<(), String> {
    let normalised = match bubble_size_to_scale(&size) {
        Some(scale) => format!("{:.2}", scale),
        None => "auto".to_string(),
    };
    if let Some(db_state) = app.try_state::<DbState>() {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('bubble_size', ?1)",
            rusqlite::params![normalised],
        )
        .map_err(|e| e.to_string())?;
    }
    // Re-place the (idle) bubble right away so the change is immediately visible.
    show_bubble_window(&app);
    app.emit("bubble-size-changed", normalised).ok();
    Ok(())
}

/// Return the bubble's current position as a fraction (0..1) of the work area's
/// available span. `None` if it's still at the default bottom-right anchor.
#[tauri::command]
fn get_bubble_position(app: tauri::AppHandle) -> Option<(f64, f64)> {
    saved_bubble_pos(&app)
}

/// Nudge the floating bubble by a fractional step (used by the Settings D-pad).
/// `dx`/`dy` are deltas in work-area fractions; positive moves right/down. The new
/// position is clamped to the visible work area, persisted, and applied immediately.
/// Returns the new `(fx, fy)`.
#[tauri::command]
fn nudge_bubble(app: tauri::AppHandle, dx: f64, dy: f64) -> Option<(f64, f64)> {
    let b = app.get_webview_window("bubble")?;
    let monitor = b.current_monitor().ok()??;
    let monitor_size = monitor.size();
    let wa = monitor.work_area();
    let (area_x, area_y, area_w, area_h) = if wa.size.width > 0 && wa.size.height > 0 {
        (
            wa.position.x,
            wa.position.y,
            wa.size.width as i32,
            wa.size.height as i32,
        )
    } else {
        let p = monitor.position();
        (
            p.x,
            p.y,
            monitor_size.width as i32,
            monitor_size.height as i32,
        )
    };

    let size = b.outer_size().ok()?;
    let avail_w = (area_w - size.width as i32).max(1);
    let avail_h = (area_h - size.height as i32).max(1);

    // Seed from the saved fraction, or derive it from where the window sits right now
    // (so the first nudge starts from the default bottom-right spot, not the corner).
    let (cur_fx, cur_fy) = saved_bubble_pos(&app).unwrap_or_else(|| {
        let pos = b.outer_position().unwrap_or(tauri::PhysicalPosition {
            x: area_x + avail_w,
            y: area_y + avail_h,
        });
        (
            (pos.x - area_x) as f64 / avail_w as f64,
            (pos.y - area_y) as f64 / avail_h as f64,
        )
    });

    let fx = (cur_fx + dx).clamp(0.0, 1.0);
    let fy = (cur_fy + dy).clamp(0.0, 1.0);

    if let Some(db) = app.try_state::<DbState>() {
        if let Ok(conn) = db.0.lock() {
            let _ = conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('bubble_pos', ?1)",
                rusqlite::params![format!("{:.4},{:.4}", fx, fy)],
            );
        }
    }

    let x = area_x + (fx * avail_w as f64).round() as i32;
    let y = area_y + (fy * avail_h as f64).round() as i32;
    let _ = b.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
    Some((fx, fy))
}

/// Clear the custom bubble position and snap it back to the default bottom-right anchor.
#[tauri::command]
fn reset_bubble_position(app: tauri::AppHandle) {
    if let Some(db) = app.try_state::<DbState>() {
        if let Ok(conn) = db.0.lock() {
            let _ = conn.execute("DELETE FROM settings WHERE key = 'bubble_pos'", []);
        }
    }
    show_bubble_window(&app);
}
