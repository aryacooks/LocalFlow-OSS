mod audio;
mod cleanup;
mod db;
mod download;
mod earcon;
mod emoji;
#[cfg(any(target_os = "macos", test))]
mod fn_gesture;
#[cfg(windows)]
#[path = "hook_windows.rs"]
mod hook;
#[cfg(not(windows))]
#[path = "hook_macos.rs"]
mod hook;
mod inject;
mod llm;
mod mac_permissions;
mod notch;
mod parakeet;
mod placement;
mod placer;
mod pastecard;
mod appicon;
mod thermal;
mod vocab;
mod pipeline;
mod translit;
mod update;
mod dravidian;
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
        // Must be registered first. A second launch (login item + manual open, a
        // double-click in Finder) would otherwise run a second copy: two hotkey hooks,
        // two bubbles, two pastes. The new copy exits and the running one shows itself.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                win.show().ok();
                win.set_focus().ok();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        // Over-the-air updates: checks localflow.aryab.in/downloads/latest.json, and
        // only installs builds signed with LocalFlow's update key (pubkey in tauri.conf.json).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
                    let sound_set = {
                        let conn = db_state.0.lock().unwrap();
                        conn.query_row(
                            "SELECT value FROM settings WHERE key = 'sound_set'",
                            [],
                            |r| r.get::<_, String>(0),
                        )
                        .unwrap_or_else(|_| earcon::DEFAULT_SOUND_SET.to_string())
                    };
                    earcon::set_sound_set(&sound_set);
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
                    // Off unless turned on (key renamed so the new default applies).
                    if let Ok(rom) = conn.query_row(
                        "SELECT value FROM settings WHERE key = 'romanize_hindi'",
                        [],
                        |r| r.get::<_, String>(0),
                    ) {
                        *pipeline_state.romanize.lock().unwrap() = rom == "true";
                    }
                    if let Ok(langs) = conn.query_row(
                        "SELECT value FROM settings WHERE key = 'languages'",
                        [],
                        |r| r.get::<_, String>(0),
                    ) {
                        let list = pipeline::parse_languages(&langs);
                        if !list.is_empty() {
                            *pipeline_state.languages.lock().unwrap() = list;
                        }
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
                // Read the notch size now, on the main thread (AppKit), for the
                // "Notch island" bubble style.
                notch::init();
                placer::create(app.handle());
                pastecard::create(app.handle());
                // Show the bubble window on startup
                show_bubble_window(app.handle());
                // Notch island: keep it pinned if anything moves the window.
                #[cfg(target_os = "macos")]
                if let Some(bw) = app.get_webview_window("bubble") {
                    let bw2 = bw.clone();
                    bw.on_window_event(move |e| {
                        if matches!(e, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_))
                            && bubble_is_notch(bw2.app_handle())
                        {
                            notch::repin(&bw2);
                        }
                    });
                }

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
        .manage(update::PendingUpdate::default())
        .invoke_handler(tauri::generate_handler![
            // Audio
            audio::list_audio_devices,
            audio::start_audio_capture,
            audio::stop_audio_capture,
            audio::get_amplitude,
            audio::is_recording,
            audio::set_audio_device,
            // Primary key capture (Shortcuts)
            hook::capture_trigger_key,
            update::check_update,
            update::install_update,
            hook::cancel_trigger_capture,
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
            inject::set_text_focus,
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
            pipeline::set_languages,
            pipeline::get_pipeline_status,
            // Frontend-callable
            start_recording_cmd,
            set_bubble_visible,
            set_earcons_enabled,
            set_sound_set,
            set_bubble_mode,
            get_notch_geometry,
            stop_and_transcribe_cmd,
            get_system_stats,
            reload_global_shortcut,
            quit_app,
            open_main_window,
            resize_bubble,
            set_bubble_size,
            get_bubble_placement,
            set_bubble_placement,
            get_nudge_range,
            appicon::get_app_icon,
            drag_bubble,
            drop_bubble,
            placer::get_placer_layout,
            pastecard::get_paste_card,
            pastecard::hide_paste_card,
            inject::copy_to_clipboard,
            placer::toggle_placing,
            placer::cancel_placing,
            placer::place_at_spot,
        ])
        .build(tauri::generate_context!())
        .expect("error while running LocalFlow")
        .run(|_app_handle, _event| {
            // Release the Whisper model before the process exits.
            //
            // ggml destroys its global Metal device from a C++ static destructor during
            // `exit()`. If a WhisperContext is still alive then, it still holds Metal
            // resource sets, and `ggml_metal_rsets_free` trips
            // `GGML_ASSERT([rsets->data count] == 0)` and calls `abort()` — macOS then
            // reports "LocalFlow quit unexpectedly" on a perfectly normal Quit.
            //
            // The cache is a Rust `static`, so its Drop never runs on its own; nothing
            // frees the context unless we do it here, while it is still safe to.
            // ExitRequested covers Quit/Cmd-Q, Exit covers the rest — both fire before
            // the static destructors, and dropping twice is harmless.
            match _event {
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    whisper::invalidate_model_cache();
                }
                // macOS: clicking the Dock icon while the window is hidden re-shows it.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    // A click on the paste card or the placement guide can activate
                    // the app; that must not pop the settings window open.
                    let overlay_up = ["card", "placer"].iter().any(|l| {
                        _app_handle
                            .get_webview_window(l)
                            .map(|w| w.is_visible().unwrap_or(false))
                            .unwrap_or(false)
                    });
                    if overlay_up {
                        return;
                    }
                    if let Some(win) = _app_handle.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
                _ => {}
            }
        });
}
/// Logical size of the bubble window when it only shows the orb (idle or active).
const BUBBLE_IDLE_W: f64 = placement::ORB_BOX;
const BUBBLE_IDLE_H: f64 = placement::ORB_BOX;

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

/// The orb's spot (one of `placement::SPOTS`) and horizontal shift in logical points.
fn saved_placement(app: &tauri::AppHandle) -> (String, f64, f64) {
    let get = |key: &str| -> Option<String> {
        let db = app.try_state::<DbState>()?;
        let conn = db.0.lock().ok()?;
        conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
            .ok()
    };
    let spot = get("bubble_spot")
        .filter(|s| placement::is_spot(s))
        .unwrap_or_else(|| placement::DEFAULT_SPOT.to_string());
    let num = |key: &str| {
        get(key)
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite())
            .unwrap_or(0.0)
            .clamp(-placement::NUDGE_MAX, placement::NUDGE_MAX)
    };
    (spot, num("bubble_nudge"), num("bubble_nudge_y"))
}

/// The monitor's work area (excludes menu bar / Dock / taskbar), or the full monitor
/// if the platform reports nothing usable.
fn work_area(monitor: &tauri::Monitor) -> placement::Area {
    let wa = monitor.work_area();
    if wa.size.width > 0 && wa.size.height > 0 {
        placement::Area {
            x: wa.position.x as f64,
            y: wa.position.y as f64,
            w: wa.size.width as f64,
            h: wa.size.height as f64,
        }
    } else {
        let p = monitor.position();
        placement::Area {
            x: p.x as f64,
            y: p.y as f64,
            w: monitor.size().width as f64,
            h: monitor.size().height as f64,
        }
    }
}

/// The whole monitor below the menu bar: how far the orb may be shifted. Unlike the
/// work area it includes the Dock / taskbar strip, so the orb can sit right at the
/// bottom or side edge (the bubble's window level keeps it above the Dock).
fn free_area(monitor: &tauri::Monitor) -> placement::Area {
    let p = monitor.position();
    let (x, y) = (p.x as f64, p.y as f64);
    let (w, h) = (monitor.size().width as f64, monitor.size().height as f64);
    let wa = work_area(monitor);
    // Keep below the macOS menu bar (the work area's top edge), nothing else.
    let top = if cfg!(target_os = "macos") { wa.y.max(y) } else { y };
    placement::Area { x, y: top, w, h: (y + h - top).max(1.0) }
}

/// Bubble scale (Settings size override, else the display heuristic) times DPI.
fn adaptive_scale_for(b: &tauri::WebviewWindow, monitor: &tauri::Monitor) -> f64 {
    let base = user_scale_override(b.app_handle())
        .unwrap_or_else(|| bubble_scale(*monitor.size(), monitor.scale_factor()));
    monitor.scale_factor() * base
}

/// Size the bubble window to the given logical (CSS-px) dimensions and pin its
/// bottom-right corner just inside the active monitor's **work area** — the region
/// that excludes the macOS Dock + menu bar (and the Windows taskbar). Anchoring to the
/// work area instead of the full display keeps the bubble from hiding behind the Dock:
/// a normal always-on-top window sits *below* the macOS Dock. The window is always
/// right-anchored, so changing the width only moves the LEFT edge — the logo never
/// shifts on screen.
fn place_bubble(b: &tauri::WebviewWindow, logical_w: f64, logical_h: f64) {
    // Notch island: a fixed-size window flush with the top of the notch screen,
    // centred on the notch. Size and position settings don't apply.
    if bubble_is_notch(b.app_handle()) {
        if let Some(monitor) = notch::notch_monitor(b) {
            let sf = monitor.scale_factor();
            let (w, h) = notch::window_size();
            let width = (w * sf).round() as u32;
            let height = (h * sf).round() as u32;
            let p = monitor.position();
            let x = p.x + (monitor.size().width as i32 - width as i32) / 2;
            let _ = b.set_size(tauri::Size::Physical(tauri::PhysicalSize { width, height }));
            // On macOS the final frame is set in notch::apply_window_mode (AppKit would
            // clamp this position to below the menu bar).
            if !cfg!(target_os = "macos") {
                let _ = b.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y: p.y }));
            }
        }
        return;
    }
    if let Ok(Some(monitor)) = b.current_monitor() {
        // Bubble sizing is unaffected by the Dock/taskbar, so it keys off the FULL
        // display size. A manual screen-size override (Settings) wins.
        let adaptive_scale = adaptive_scale_for(b, &monitor);
        let width = (logical_w * adaptive_scale).round();
        let height = (logical_h * adaptive_scale).round();

        // The orb sits in one of 8 spots (+ the user's left/right shift); a bigger
        // window (menu, error) grows away from the screen edge so the orb stays put.
        let (spot, nudge, nudge_y) = saved_placement(b.app_handle());
        let orb = (placement::ORB_BOX * adaptive_scale).round();
        let margin = placement::EDGE_MARGIN * adaptive_scale;
        let orb_at = placement::orb_origin_free(
            &spot,
            work_area(&monitor),
            free_area(&monitor),
            orb,
            margin,
            nudge * monitor.scale_factor(),
            nudge_y * monitor.scale_factor(),
        );
        let (x, y) = placement::window_origin(&spot, orb_at, orb, width, height);

        let _ = b.set_size(tauri::Size::Physical(tauri::PhysicalSize {
            width: width as u32,
            height: height as u32,
        }));
        let _ = b.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: x.round() as i32,
            y: y.round() as i32,
        }));
    }
}

/// Whether the bubble uses the "Notch island" style (Settings → Display, macOS only).
fn bubble_is_notch(app: &tauri::AppHandle) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    app.try_state::<DbState>()
        .and_then(|db| {
            let conn = db.0.lock().ok()?;
            conn.query_row(
                "SELECT value FROM settings WHERE key = 'bubble_style'",
                [],
                |r| r.get::<_, String>(0),
            )
            .ok()
        })
        .map(|v| v == "notch")
        .unwrap_or(false)
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
        notch::apply_window_mode(&b, bubble_is_notch(app));
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

    // The user's dictionary: biases Whisper, fixes "sounds like" spellings, and
    // reaches the AI cleanup (see vocab.rs).
    let vocab_terms = vocab::load_from_app(app);
    let dict_prompt = vocab::whisper_prompt(&vocab_terms);

    let language = pipeline.current_language.lock().unwrap().clone();
    let romanize = *pipeline.romanize.lock().unwrap();
    let allowed_langs = pipeline.languages.lock().unwrap().clone();

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

    let local = tauri::async_runtime::spawn_blocking(move || {
        // Reuses the already-loaded model; only the first dictation after a launch or a
        // model switch pays the disk read.
        whisper::transcribe_with_model(&model_str, &audio_data, &lang, &allowed_langs, &prompt)
    })
    .await;
    let raw_text = match local {
        Ok(Ok(text)) => Ok(text),
        // "Sounded like Tamil. Add it in Language Model..." is advice, shown as it is.
        Ok(Err(error)) if whisper::is_language_hint(&error) => Err(error),
        Ok(Err(error)) => Err(format!("Transcription error: {}", error)),
        Err(error) => Err(format!("Task join error: {}", error)),
    };

    let raw = match raw_text {
        // Romanize Devanagari → Latin ("Hinglish") when the toggle is on. No-op for
        // English/other Latin output, so it's safe to apply unconditionally here.
        Ok(t) => {
            if romanize {
                translit::devanagari_to_latin(&t)
            } else {
                t
            }
        }
        Err(msg) => {
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

    // Whisper sometimes answers silence by reading its prompt (the dictionary) back.
    if vocab::only_repeats_prompt(&raw, &vocab_terms) {
        app.emit(
            "processing-done",
            serde_json::json!({"error": "No speech detected"}),
        )
        .ok();
        return;
    }

    // The user's own spelling rules apply whether or not cleanup is on.
    let heard = vocab::apply(&raw, &vocab_terms);

    let formatted = cleanup::formatting_enabled(&app);
    let cleaned = match cleanup::cleanup_text(app.clone(), heard.clone(), app_exe.clone()) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("Cleanup error: {}", e);
            heard.clone()
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
                "INSERT INTO dictation_history (app_name, app_exe, raw_text, cleaned_text, word_count, duration_secs, language, formatted) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![final_app_name, final_app_exe, final_raw, final_cleaned, word_count, duration_secs, language, formatted],
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

    // Inject, then check whether anything could have taken the text: if clearly not
    // (or the paste failed), show the card with a Copy button so the words aren't lost.
    let pasted = inject::inject_text_clipboard(text_to_inject.clone()).await;
    // Checked after the paste so it never delays typing; the paste doesn't move focus.
    // Dictating into LocalFlow's own window: the OS can't see into our webview, so use
    // what the window reported (a text box focused or not).
    let accepts_text = if inject::foreground_is_self() {
        Some(inject::self_text_focused())
    } else {
        tauri::async_runtime::spawn_blocking(inject::focused_accepts_text)
            .await
            .ok()
            .flatten()
    };
    if let Err(e) = &pasted {
        eprintln!("Injection failed: {}", e);
    }
    let landed = pasted.is_ok() && accepts_text != Some(false);
    eprintln!("paste check: pasted_ok={} accepts_text={:?}", pasted.is_ok(), accepts_text);
    if !landed {
        let ah = app.clone();
        let text = text_to_inject.clone();
        let _ = app.run_on_main_thread(move || pastecard::show(&ah, &text));
    }
    // Tell the Dashboard where the text went (or that it went to the copy card).
    app.emit(
        "paste-result",
        serde_json::json!({ "app_name": app_name, "app_exe": app_exe, "pasted": landed }),
    )
    .ok();

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

/// Keep the mic open a moment longer so the last word isn't clipped, then stop. The
/// stop sound plays after the mic closes, so it is never recorded into the dictation.
pub(crate) async fn stop_after_tail(audio: &Arc<audio::AudioState>) {
    tokio::time::sleep(std::time::Duration::from_millis(audio::TAIL_MS)).await;
    audio::stop_capture_internal(audio);
    earcon::play_stop_sound();
}

pub(crate) fn hook_stop_and_transcribe(
    app: &tauri::AppHandle,
    audio: &Arc<audio::AudioState>,
    pipeline: &Arc<PipelineState>,
) {
    if !*audio.is_recording.lock().unwrap() {
        return;
    }
    let ah = app.clone();
    let audio_h = audio.clone();
    let pipeline_h = pipeline.clone();
    tauri::async_runtime::spawn(async move {
        stop_after_tail(&audio_h).await;
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
    stop_after_tail(audio.inner()).await;

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
    /// Hottest CPU die sensor in °C (None where it can't be read).
    pub cpu_temp_c: Option<f64>,
    /// macOS thermal pressure: Normal / Warm / Hot / Critical.
    pub thermal_state: Option<String>,
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
        cpu_temp_c: thermal::cpu_temp_c(), // cached; a sensor read is ~1 ms
        thermal_state: thermal::thermal_state().map(String::from),
    })
}

/// Whether a trigger is switched on in Settings → Shortcuts. Each trigger has an
/// "<name>_enabled" setting; missing means on, so older installs keep working.
pub fn trigger_enabled(app: &tauri::AppHandle, key: &str) -> bool {
    if let Some(db_state) = app.try_state::<crate::db::DbState>() {
        if let Ok(conn) = db_state.0.lock() {
            return conn
                .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get::<_, String>(0))
                .map(|v| v != "false")
                .unwrap_or(true);
        }
    }
    true
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

    if trigger_enabled(app, "shortcut_toggle_enabled") {
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
                tauri::async_runtime::spawn(async move {
                    crate::stop_after_tail(&audio_h).await;
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
    }

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
            // Switched off in Settings → Shortcuts.
            Ok(_) if !trigger_enabled(app, "keybind_instant_enabled") => {}
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
                            let ah = app.clone();
                            let audio_h = audio.inner().clone();
                            let pipeline_h = pipeline.inner().clone();
                            tauri::async_runtime::spawn(async move {
                                crate::stop_after_tail(&audio_h).await;
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
fn set_bubble_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    write_setting(&app, "show_bubble", if visible { "true" } else { "false" })?;
    if let Some(b) = app.get_webview_window("bubble") {
        if visible {
            let _ = b.set_focusable(false); // never steal focus from the dictation target
            place_bubble(&b, BUBBLE_IDLE_W, BUBBLE_IDLE_H);
            let _ = b.show();
            let _ = b.set_always_on_top(true);
            notch::apply_window_mode(&b, bubble_is_notch(&app));
        } else {
            let _ = b.hide();
        }
    }
    let _ = app.emit("display-settings-changed", serde_json::json!({ "bubble": visible }));
    Ok(())
}

/// Enable or disable the UI beeps (Settings → Display toggle).
#[tauri::command]
fn set_earcons_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    write_setting(&app, "play_sounds", if enabled { "true" } else { "false" })?;
    crate::earcon::set_sounds_enabled(enabled);
    let _ = app.emit("display-settings-changed", serde_json::json!({ "sounds": enabled }));
    Ok(())
}

/// Pick which start/stop sounds play (Settings → Display), and play the start cue
/// so the user hears what they chose.
#[tauri::command]
fn set_sound_set(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if !crate::earcon::is_known_sound_set(&id) {
        return Err(format!("Unknown sound set: {id}"));
    }
    write_setting(&app, "sound_set", &id)?;
    crate::earcon::set_sound_set(&id);
    crate::earcon::preview_sound_set(&id);
    Ok(())
}

/// The one "Animation" switch (Settings → Display): "screen" (floating orb), "notch"
/// (the island, macOS only) or "off". Stored as the two settings the rest of the app
/// already reads: `bubble_style` and `show_bubble`.
#[tauri::command]
fn set_bubble_mode(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    match mode.as_str() {
        "screen" | "notch" => {
            let style = if mode == "notch" { "notch" } else { "classic" };
            write_setting(&app, "bubble_style", style)?;
            let _ = app.emit("bubble-mode-changed", style);
            set_bubble_visible(app.clone(), true)?;
        }
        "off" => set_bubble_visible(app.clone(), false)?,
        _ => return Err(format!("Unknown bubble mode: {mode}")),
    }
    Ok(())
}


/// Notch size in points (falls back to a typical notch on screens without one), so
/// the island can match it exactly.
#[tauri::command]
fn get_notch_geometry() -> notch::NotchGeometry {
    notch::geometry()
}

fn write_setting(app: &tauri::AppHandle, key: &str, value: &str) -> Result<(), String> {
    let db = app
        .try_state::<DbState>()
        .ok_or_else(|| "Database not ready".to_string())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        rusqlite::params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
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

/// The orb's spot and left/right shift (logical points), for Settings.
#[tauri::command]
fn get_bubble_placement(app: tauri::AppHandle) -> (String, f64, f64) {
    saved_placement(&app)
}

fn store_placement(app: &tauri::AppHandle, spot: &str, nudge: f64, nudge_y: f64) -> Result<(), String> {
    write_setting(app, "bubble_spot", spot)?;
    write_setting(app, "bubble_nudge", &format!("{:.0}", nudge))?;
    write_setting(app, "bubble_nudge_y", &format!("{:.0}", nudge_y))?;
    let _ = app.emit(
        "bubble-placement-changed",
        serde_json::json!({ "spot": spot, "nudge": nudge, "nudge_y": nudge_y }),
    );
    Ok(())
}

/// How far the orb can shift from `spot` on its current screen, in logical points:
/// [min_x, max_x, min_y, max_y, screen_w, screen_h]. Settings uses it for the sliders.
#[tauri::command]
fn get_nudge_range(app: tauri::AppHandle, spot: String) -> Option<[f64; 6]> {
    let b = app.get_webview_window("bubble")?;
    let monitor = b
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| b.primary_monitor().ok().flatten())?;
    let sf = monitor.scale_factor();
    let scale = adaptive_scale_for(&b, &monitor);
    let orb = (placement::ORB_BOX * scale).round();
    let margin = placement::EDGE_MARGIN * scale;
    let spot = if placement::is_spot(&spot) { spot } else { placement::DEFAULT_SPOT.to_string() };
    let (a, bx, c, d) = placement::nudge_range(&spot, work_area(&monitor), free_area(&monitor), orb, margin);
    let size = monitor.size();
    Some([
        (a / sf).ceil(),
        (bx / sf).floor(),
        (c / sf).ceil(),
        (d / sf).floor(),
        size.width as f64 / sf,
        size.height as f64 / sf,
    ])
}

/// Put the orb in a spot with a left/right and up/down shift (Settings → Orb position).
#[tauri::command]
fn set_bubble_placement(app: tauri::AppHandle, spot: String, nudge: f64, nudge_y: f64) -> Result<(), String> {
    if !placement::is_spot(&spot) {
        return Err(format!("Unknown spot: {spot}"));
    }
    let clean = |v: f64| if v.is_finite() { v.clamp(-placement::NUDGE_MAX, placement::NUDGE_MAX) } else { 0.0 };
    store_placement(&app, &spot, clean(nudge), clean(nudge_y))?;
    show_bubble_window(&app);
    Ok(())
}

/// The spot nearest a physical point and where the orb-sized window would sit there
/// (physical top-left), plus the orb size.
fn snap_target(b: &tauri::WebviewWindow, cx: f64, cy: f64) -> Option<(&'static str, (f64, f64), f64)> {
    let monitor = monitor_at(b, cx, cy)?;
    let scale = adaptive_scale_for(b, &monitor);
    let orb = (placement::ORB_BOX * scale).round();
    let margin = placement::EDGE_MARGIN * scale;
    let area = work_area(&monitor);
    let spot = placement::nearest_spot(area, orb, margin, cx, cy);
    let at = placement::orb_origin(spot, area, orb, margin, 0.0, 0.0);
    Some((spot, at, orb))
}

/// Live drag: move the bubble window so its top-left is at (x, y) logical screen points.
/// Near a spot the orb is pulled towards it, like a magnet.
#[tauri::command]
fn drag_bubble(app: tauri::AppHandle, x: f64, y: f64) {
    let Some(b) = app.get_webview_window("bubble") else { return };
    let sf = b.scale_factor().unwrap_or(1.0);
    let Ok(size) = b.outer_size() else { return };
    let (w, h) = (size.width as f64, size.height as f64);
    let (mut px, mut py) = (x * sf, y * sf);
    let (cx, cy) = (px + w / 2.0, py + h / 2.0);
    if let Some((_, at, orb)) = snap_target(&b, cx, cy) {
        let (sx, sy) = (at.0 + orb / 2.0, at.1 + orb / 2.0);
        let d = ((sx - cx).powi(2) + (sy - cy).powi(2)).sqrt();
        let reach = orb * 1.8;
        if d < reach {
            let k = (1.0 - d / reach).powi(2) * 0.85;
            px += (sx - cx) * k;
            py += (sy - cy) * k;
        }
    }
    let _ = b.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
        x: px.round() as i32,
        y: py.round() as i32,
    }));
    // Show the drop guide and highlight the spot the orb will snap to.
    placer::update(&app, &b, px + w / 2.0, py + h / 2.0);
}

/// The monitor containing a physical point, else the window's current monitor.
fn monitor_at(b: &tauri::WebviewWindow, cx: f64, cy: f64) -> Option<tauri::Monitor> {
    b.available_monitors()
        .ok()?
        .into_iter()
        .find(|m| {
            let (p, s) = (m.position(), m.size());
            cx >= p.x as f64
                && cx < p.x as f64 + s.width as f64
                && cy >= p.y as f64
                && cy < p.y as f64 + s.height as f64
        })
        .or_else(|| b.current_monitor().ok().flatten())
}

/// End of a drag: snap the orb to the spot nearest where it was dropped (on whichever
/// screen it's on now), clear the shift, and return the spot.
#[tauri::command]
fn drop_bubble(app: tauri::AppHandle) -> Option<String> {
    placer::hide(&app);
    let b = app.get_webview_window("bubble")?;
    let pos = b.outer_position().ok()?;
    let size = b.outer_size().ok()?;
    let (w, h) = (size.width as f64, size.height as f64);
    let cx = pos.x as f64 + w / 2.0;
    let cy = pos.y as f64 + h / 2.0;
    let (spot, at, orb) = snap_target(&b, cx, cy)?;
    store_placement(&app, spot, 0.0, 0.0).ok()?;
    // Glide to the spot (ease-out with a touch of overshoot, ~280 ms), then let
    // place_bubble set the exact final frame.
    let (fx, fy) = (pos.x as f64, pos.y as f64);
    let (tx, ty) = placement::window_origin(spot, at, orb, w, h);
    let bw = b.clone();
    std::thread::spawn(move || {
        let back = |t: f64| {
            let c = 1.4;
            1.0 + (c + 1.0) * (t - 1.0).powi(3) + c * (t - 1.0).powi(2)
        };
        let frames = 17;
        for i in 1..=frames {
            let k = back(i as f64 / frames as f64);
            let _ = bw.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: (fx + (tx - fx) * k).round() as i32,
                y: (fy + (ty - fy) * k).round() as i32,
            }));
            std::thread::sleep(std::time::Duration::from_millis(16));
        }
        place_bubble(&bw, BUBBLE_IDLE_W, BUBBLE_IDLE_H);
    });
    Some(spot.to_string())
}
