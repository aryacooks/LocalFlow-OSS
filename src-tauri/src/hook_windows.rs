use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
    SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG,
    MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_MBUTTONDOWN,
    WM_MBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
};

fn get_db_setting(key: &str, default: &str) -> String {
    if let Some(app) = APP_HANDLE.get() {
        if let Some(db_state) = app.try_state::<crate::db::DbState>() {
            let conn = db_state.0.lock().unwrap();
            let val: Result<String, _> = conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get(0),
            );
            return val.unwrap_or_else(|_| default.to_string());
        }
    }
    default.to_string()
}

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static AUDIO_STATE: OnceLock<Arc<crate::audio::AudioState>> = OnceLock::new();
static PIPELINE_STATE: OnceLock<Arc<crate::pipeline::PipelineState>> = OnceLock::new();

// Keyboard state tracking
static LAST_RSHIFT_TIME: Mutex<Option<std::time::Instant>> = Mutex::new(None);
static CTRL_PRESSED: Mutex<bool> = Mutex::new(false);
static ALT_PRESSED: Mutex<bool> = Mutex::new(false);
static SHIFT_PRESSED: Mutex<bool> = Mutex::new(false);
static RALT_HELD_RECORDING: Mutex<bool> = Mutex::new(false);
static MOUSE_HELD_RECORDING: Mutex<bool> = Mutex::new(false);
static KB_KEY_CONSUMED: Mutex<bool> = Mutex::new(false);
static MOUSE_KEY_CONSUMED: Mutex<bool> = Mutex::new(false);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum RecordTrigger {
    Toggle,
    Hold,
    Command,
}

static RECORD_TRIGGER: Mutex<Option<RecordTrigger>> = Mutex::new(None);

pub fn init_hook(
    app: AppHandle,
    audio: Arc<crate::audio::AudioState>,
    pipeline: Arc<crate::pipeline::PipelineState>,
) {
    let _ = APP_HANDLE.set(app);
    let _ = AUDIO_STATE.set(audio);
    let _ = PIPELINE_STATE.set(pipeline);

    // Spawn the Windows Hook thread
    std::thread::spawn(|| unsafe {
        run_hook_loop();
    });
}

unsafe fn run_hook_loop() {
    let k_hook = SetWindowsHookExW(
        WH_KEYBOARD_LL,
        Some(low_level_keyboard_hook_callback),
        HINSTANCE::default(),
        0,
    );
    let m_hook = SetWindowsHookExW(
        WH_MOUSE_LL,
        Some(low_level_mouse_hook_callback),
        HINSTANCE::default(),
        0,
    );

    let k_ok = k_hook.is_ok();
    let m_ok = m_hook.is_ok();

    if k_ok || m_ok {
        println!(
            "Low-level hooks installed successfully. Keyboard: {}, Mouse: {}",
            k_ok, m_ok
        );
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND::default(), 0, 0).0 != 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if let Ok(kh) = k_hook {
            let _ = UnhookWindowsHookEx(kh);
        }
        if let Ok(mh) = m_hook {
            let _ = UnhookWindowsHookEx(mh);
        }
    } else {
        eprintln!(
            "Failed to install low-level hooks. Keyboard: {:?}, Mouse: {:?}",
            k_hook.err(),
            m_hook.err()
        );
    }
}

unsafe extern "system" fn low_level_mouse_hook_callback(
    code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if code >= 0 {
        let hook_struct = *(lparam.0 as *const MSLLHOOKSTRUCT);
        let event = wparam.0 as u32;

        if handle_mouse(event, &hook_struct) {
            return LRESULT(1); // Consume the mouse event
        }
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

fn handle_mouse(event: u32, hook_struct: &MSLLHOOKSTRUCT) -> bool {
    let app = match APP_HANDLE.get() {
        Some(a) => a,
        None => return false,
    };
    let audio = match AUDIO_STATE.get() {
        Some(a) => a,
        None => return false,
    };
    let pipeline = match PIPELINE_STATE.get() {
        Some(p) => p,
        None => return false,
    };

    let is_recording = *audio.is_recording.lock().unwrap();
    let is_processing = *pipeline.is_processing.lock().unwrap();

    let mouse_toggle = get_db_setting("keybind_mouse_toggle", "none");
    let mouse_instant = get_db_setting("keybind_mouse_instant", "none");

    let matches_bind = |bind: &str| -> (bool, bool) {
        match bind {
            "middle" => (event == WM_MBUTTONDOWN, event == WM_MBUTTONUP),
            "right" => (event == 0x0204, event == 0x0205),
            "button4" | "back" => {
                if event == WM_XBUTTONDOWN || event == WM_XBUTTONUP {
                    let button = (hook_struct.mouseData >> 16) as u16;
                    (
                        event == WM_XBUTTONDOWN && button == 1,
                        event == WM_XBUTTONUP && button == 1,
                    )
                } else {
                    (false, false)
                }
            }
            "button5" | "forward" => {
                if event == WM_XBUTTONDOWN || event == WM_XBUTTONUP {
                    let button = (hook_struct.mouseData >> 16) as u16;
                    (
                        event == WM_XBUTTONDOWN && button == 2,
                        event == WM_XBUTTONUP && button == 2,
                    )
                } else {
                    (false, false)
                }
            }
            _ => (false, false),
        }
    };

    // 1. Process Instant Dictation (Hold to Talk)
    if mouse_instant != "none" {
        let (down, up) = matches_bind(&mouse_instant);
        if down {
            *MOUSE_KEY_CONSUMED.lock().unwrap() = true;
            if !is_recording && !is_processing {
                // Atomically check-and-set to prevent duplicate start
                let mut held = MOUSE_HELD_RECORDING.lock().unwrap();
                if !*held {
                    *held = true;
                    drop(held);
                    start_hold_recording(app.clone(), audio.clone());
                }
            }
            return true; // Consume event
        } else if up {
            // Atomically read-and-clear consumed flag
            let was_consumed = {
                let mut lock = MOUSE_KEY_CONSUMED.lock().unwrap();
                let v = *lock;
                *lock = false;
                v
            };

            // Atomically check-and-clear: only fires once per hold session
            let was_held = {
                let mut held = MOUSE_HELD_RECORDING.lock().unwrap();
                let v = *held;
                *held = false;
                v
            };
            if was_held {
                let trigger = *RECORD_TRIGGER.lock().unwrap();
                if trigger == Some(RecordTrigger::Hold) {
                    stop_and_transcribe(app.clone(), audio.clone(), pipeline.clone());
                }
            }
            if was_consumed {
                return true; // Consume event
            }
        }
    }

    // 2. Process Toggle Dictation (Tap to Toggle)
    if mouse_toggle != "none" {
        let (down, _up) = matches_bind(&mouse_toggle);
        if down {
            if !is_processing {
                toggle_recording(app.clone(), audio.clone(), pipeline.clone());
            }
            return true; // Consume event
        }
    }

    // 3. Block Browser navigation on Mouse Button 4 & 5 when LocalFlow is in foreground
    let is_xbutton = event == WM_XBUTTONDOWN || event == WM_XBUTTONUP;
    if is_xbutton {
        let button = (hook_struct.mouseData >> 16) as u16;
        if button == 1 || button == 2 {
            let is_app_foreground = unsafe {
                let hwnd = GetForegroundWindow();
                if !hwnd.0.is_null() {
                    let mut pid = 0u32;
                    GetWindowThreadProcessId(hwnd, Some(&mut pid));
                    pid == std::process::id()
                } else {
                    false
                }
            };
            if is_app_foreground {
                return true; // Block XButton navigation inside WebView2
            }
        }
    }

    false
}

unsafe extern "system" fn low_level_keyboard_hook_callback(
    code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if code >= 0 {
        let hook_struct = *(lparam.0 as *const KBDLLHOOKSTRUCT);
        let vk_code = hook_struct.vkCode;
        let event = wparam.0 as u32;

        let is_key_down = event == WM_KEYDOWN || event == WM_SYSKEYDOWN;
        let is_key_up = event == WM_KEYUP || event == WM_SYSKEYUP;

        if handle_key(vk_code, is_key_down, is_key_up) {
            // Block key propagation
            return LRESULT(1);
        }
    }

    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

fn handle_key(vk_code: u32, is_key_down: bool, is_key_up: bool) -> bool {
    println!(
        "Hook DBG: handle_key vk_code={}, is_down={}, is_up={}",
        vk_code, is_key_down, is_key_up
    );
    let app = match APP_HANDLE.get() {
        Some(a) => a,
        None => return false,
    };
    let audio = match AUDIO_STATE.get() {
        Some(a) => a,
        None => return false,
    };
    let pipeline = match PIPELINE_STATE.get() {
        Some(p) => p,
        None => return false,
    };

    let is_recording = *audio.is_recording.lock().unwrap();
    let is_processing = *pipeline.is_processing.lock().unwrap();

    // 1. ESCAPE key (VK_ESCAPE = 0x1B)
    if vk_code == 0x1B {
        if is_key_down && is_recording {
            cancel_recording(app, audio, pipeline);
            return true; // Consume Escape key so it doesn't propagate to active app
        }
    }

    // Track state of modifier keys
    // VK_LSHIFT = 0xA0, VK_RSHIFT = 0xA1, VK_SHIFT = 0x10
    // VK_LCONTROL = 0xA2, VK_RCONTROL = 0xA3, VK_CONTROL = 0x11
    // VK_LMENU (Left Alt) = 0xA4, VK_RMENU (Right Alt) = 0xA5, VK_MENU = 0x12
    if vk_code == 0x11 || vk_code == 0xA2 || vk_code == 0xA3 {
        *CTRL_PRESSED.lock().unwrap() = is_key_down;
    }
    if vk_code == 0x12 || vk_code == 0xA4 || vk_code == 0xA5 {
        *ALT_PRESSED.lock().unwrap() = is_key_down;
    }
    if vk_code == 0x10 || vk_code == 0xA0 || vk_code == 0xA1 {
        *SHIFT_PRESSED.lock().unwrap() = is_key_down;
    }

    let ctrl_pressed = *CTRL_PRESSED.lock().unwrap();
    let alt_pressed = *ALT_PRESSED.lock().unwrap();
    let shift_pressed = *SHIFT_PRESSED.lock().unwrap();

    // Get dynamic keyboard trigger configuration
    let kb_vk_str = get_db_setting("keybind_keyboard_vk", "");
    let kb_vk = if kb_vk_str.is_empty() {
        let kb_bind = get_db_setting("keybind_keyboard", "rshift_ralt");
        match kb_bind.as_str() {
            "caps_hold" => 0x14,     // VK_CAPITAL
            "tilde_hold" => 0xC0,    // VK_OEM_3
            "rshift_double" => 0xA1, // VK_RSHIFT
            _ => 0xA5,               // VK_RMENU (Right Alt)
        }
    } else {
        kb_vk_str.parse::<u32>().unwrap_or(0x51) // default is 0x51 (Q key)
    };

    let kb_mode = "hold";

    let kb_name = get_db_setting("keybind_keyboard_name", "Ctrl+Q");
    let has_ctrl_req = kb_name.contains("Ctrl");
    let has_alt_req = kb_name.contains("Alt");
    let has_shift_req = kb_name.contains("Shift");

    let modifiers_match = (!has_ctrl_req || ctrl_pressed)
        && (!has_alt_req || alt_pressed)
        && (!has_shift_req || shift_pressed);

    // If recording in Hold-to-Talk and any required modifier is released:
    if is_key_up {
        let is_modifier_for_bind = ((vk_code == 0x11 || vk_code == 0xA2 || vk_code == 0xA3)
            && has_ctrl_req)
            || ((vk_code == 0x12 || vk_code == 0xA4 || vk_code == 0xA5) && has_alt_req)
            || ((vk_code == 0x10 || vk_code == 0xA0 || vk_code == 0xA1) && has_shift_req);

        if is_modifier_for_bind {
            // Atomically check-and-clear: only the first release path fires
            let was_held = {
                let mut held = RALT_HELD_RECORDING.lock().unwrap();
                let v = *held;
                *held = false;
                v
            };
            if was_held {
                println!(
                    "Hook DBG: modifier released, stopping hold recording: vk_code={}",
                    vk_code
                );
                let trigger = *RECORD_TRIGGER.lock().unwrap();
                if trigger == Some(RecordTrigger::Hold) {
                    stop_and_transcribe(app.clone(), audio.clone(), pipeline.clone());
                }
                return true; // Consume modifier keyup
            }
        }
    }

    if vk_code == kb_vk {
        if is_key_down {
            println!(
                "Hook DBG: target keydown, modifiers_match={}",
                modifiers_match
            );
            if modifiers_match {
                *KB_KEY_CONSUMED.lock().unwrap() = true;

                if kb_mode == "hold" {
                    let mut held = RALT_HELD_RECORDING.lock().unwrap();
                    if !*held {
                        if !is_recording && !is_processing {
                            *held = true;
                            start_hold_recording(app.clone(), audio.clone());
                        }
                    }
                } else if kb_mode == "toggle" {
                    if !is_processing {
                        toggle_recording(app.clone(), audio.clone(), pipeline.clone());
                    }
                } else if kb_mode == "double_tap" {
                    let mut last_time = LAST_RSHIFT_TIME.lock().unwrap();
                    let now = std::time::Instant::now();
                    let is_double = if let Some(prev) = *last_time {
                        now.duration_since(prev).as_millis() < 350
                    } else {
                        false
                    };

                    if is_double {
                        *last_time = None;
                        if !is_processing {
                            toggle_recording(app.clone(), audio.clone(), pipeline.clone());
                        }
                    } else {
                        *last_time = Some(now);
                    }
                }
                return true; // Consume keydown to block auto-repeat characters from typing
            }
        } else if is_key_up {
            // Atomically read-and-clear consumed flag; drop lock immediately
            let was_consumed = {
                let mut lock = KB_KEY_CONSUMED.lock().unwrap();
                let v = *lock;
                *lock = false;
                v
            };

            if kb_mode == "hold" {
                // Atomically check-and-clear: only fires if modifier path didn't already clear it
                let was_held = {
                    let mut held = RALT_HELD_RECORDING.lock().unwrap();
                    let v = *held;
                    *held = false;
                    v
                };
                if was_held {
                    println!("Hook DBG: target keyup, stopping hold recording");
                    let trigger = *RECORD_TRIGGER.lock().unwrap();
                    if trigger == Some(RecordTrigger::Hold) {
                        stop_and_transcribe(app.clone(), audio.clone(), pipeline.clone());
                    }
                }
            }

            if was_consumed {
                return true; // Consume keyup to match consumed keydown
            }
        }
    }

    false
}

fn cancel_recording(
    app: &AppHandle,
    audio: &crate::audio::AudioState,
    pipeline: &crate::pipeline::PipelineState,
) {
    println!("Cancelling recording...");
    crate::earcon::play_cancel_sound();
    {
        crate::audio::stop_capture_internal(audio);
        audio.buffer.lock().unwrap().clear();
    }
    *pipeline.is_processing.lock().unwrap() = false;
    *pipeline.is_command_mode.lock().unwrap() = false;
    *pipeline.command_mode_text.lock().unwrap() = String::new();

    *RECORD_TRIGGER.lock().unwrap() = None;
    *RALT_HELD_RECORDING.lock().unwrap() = false;
    *MOUSE_HELD_RECORDING.lock().unwrap() = false;

    app.emit("recording-stopped", ()).ok();
    app.emit("processing-done", serde_json::json!({"error": "Cancelled"}))
        .ok();
}

fn start_command_mode(
    app: &AppHandle,
    audio: &Arc<crate::audio::AudioState>,
    pipeline: &Arc<crate::pipeline::PipelineState>,
) {
    println!("Starting dictation in Command Mode...");
    *RECORD_TRIGGER.lock().unwrap() = Some(RecordTrigger::Command);
    *pipeline.is_command_mode.lock().unwrap() = true;

    let app_clone = app.clone();
    let audio_clone = audio.clone();

    tauri::async_runtime::spawn(async move {
        app_clone.emit("command-mode-started", ()).ok();

        // Copy selected text first
        let copied = match crate::inject::copy_selected_text().await {
            Ok(txt) => txt,
            Err(e) => {
                eprintln!("Failed to copy selected text: {}", e);
                String::new()
            }
        };

        if let Some(state) = app_clone.try_state::<Arc<crate::pipeline::PipelineState>>() {
            *state.command_mode_text.lock().unwrap() = copied;
        }

        crate::earcon::play_start_sound();

        // Start capturing audio
        let device = audio_clone.device_name.lock().unwrap().clone();
        let dev_opt = if device.is_empty() {
            None
        } else {
            Some(device)
        };
        if let Err(e) = crate::audio::start_capture_internal(&audio_clone, dev_opt) {
            eprintln!("Command Mode: failed to start audio capture: {}", e);
            return;
        }

        app_clone.emit("recording-started", ()).ok();
        crate::show_bubble_window(&app_clone);
    });
}

fn start_hold_recording(app: AppHandle, audio: Arc<crate::audio::AudioState>) {
    *RECORD_TRIGGER.lock().unwrap() = Some(RecordTrigger::Hold);
    tauri::async_runtime::spawn(async move {
        let trigger = *RECORD_TRIGGER.lock().unwrap();
        if trigger.is_none() {
            return;
        }
        println!("Starting dictation in Hold-to-Talk Mode...");
        crate::earcon::play_start_sound();

        let device = audio.device_name.lock().unwrap().clone();
        let dev_opt = if device.is_empty() {
            None
        } else {
            Some(device)
        };
        if let Err(e) = crate::audio::start_capture_internal(&audio, dev_opt) {
            eprintln!("Hold-to-talk: failed to start audio capture: {}", e);
            return;
        }

        let trigger_after = *RECORD_TRIGGER.lock().unwrap();
        if trigger_after.is_none() {
            println!("Hold-to-Talk trigger released during initialization, stopping immediately");
            crate::audio::stop_capture_internal(&audio);
            return;
        }

        app.emit("recording-started", ()).ok();
        crate::show_bubble_window(&app);
    });
}

fn toggle_recording(
    app: AppHandle,
    audio: Arc<crate::audio::AudioState>,
    pipeline: Arc<crate::pipeline::PipelineState>,
) {
    let is_recording = *audio.is_recording.lock().unwrap();
    if is_recording {
        stop_and_transcribe(app, audio, pipeline);
    } else {
        *RECORD_TRIGGER.lock().unwrap() = Some(RecordTrigger::Toggle);
        tauri::async_runtime::spawn(async move {
            let trigger = *RECORD_TRIGGER.lock().unwrap();
            if trigger.is_none() {
                return;
            }
            println!("Starting dictation in Toggle Mode...");
            crate::earcon::play_start_sound();

            let device = audio.device_name.lock().unwrap().clone();
            let dev_opt = if device.is_empty() {
                None
            } else {
                Some(device)
            };
            if let Err(e) = crate::audio::start_capture_internal(&audio, dev_opt) {
                eprintln!("Toggle: failed to start audio capture: {}", e);
                return;
            }

            let trigger_after = *RECORD_TRIGGER.lock().unwrap();
            if trigger_after.is_none() {
                println!("Toggle trigger cancelled during initialization, stopping immediately");
                crate::audio::stop_capture_internal(&audio);
                return;
            }

            app.emit("recording-started", ()).ok();
            crate::show_bubble_window(&app);
        });
    }
}

fn stop_and_transcribe(
    app: AppHandle,
    audio: Arc<crate::audio::AudioState>,
    pipeline: Arc<crate::pipeline::PipelineState>,
) {
    println!("Hook DBG: stop_and_transcribe entered");
    *RECORD_TRIGGER.lock().unwrap() = None;
    *RALT_HELD_RECORDING.lock().unwrap() = false;
    *MOUSE_HELD_RECORDING.lock().unwrap() = false;

    crate::earcon::play_stop_sound();

    tauri::async_runtime::spawn(async move {
        println!("Stopping recording. Transcribing...");
        crate::audio::stop_capture_internal(&audio);
        crate::run_pipeline(&app, &audio, &pipeline).await;
    });
}
