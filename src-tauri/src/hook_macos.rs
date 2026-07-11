/// hook_macos.rs — Global input hooks for non-Windows platforms.
///
/// Keyboard (toggle + hold-to-talk) is handled by `tauri-plugin-global-shortcut`
/// (see `register_global_toggle_shortcut` in lib.rs). That plugin does NOT cover
/// mouse buttons, so on macOS we install a `CGEventTap` here to support mouse-button
/// triggers (middle / right / button 4 / button 5), mirroring the Windows WH_MOUSE_LL
/// hook.
///
/// We deliberately do NOT install a background *keyboard* listener: the `rdev` crate's
/// macOS keyboard listener resolves keystroke names via HIToolbox Text Input Source
/// APIs off the main thread, which modern macOS aborts (dispatch_assert_queue →
/// SIGTRAP). A mouse event tap doesn't touch those APIs, so it runs safely on its own
/// thread.
///
/// Note: the event tap observes (ListenOnly) — the configured mouse button still
/// performs its normal action in other apps. It also requires the user to grant
/// Input Monitoring / Accessibility permission; without it the tap fails to create
/// and we degrade gracefully (keyboard shortcuts keep working).
use once_cell::sync::Lazy;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

/// In-memory cache of the mouse trigger binds, as `(instant, toggle)`. The real-time
/// `CGEventTap` callback reads this instead of querying SQLite: hitting the DB inside the
/// callback could block on the DB mutex (held during transcription / history writes) long
/// enough for macOS to disable the tap for exceeding its callback timeout — which silently
/// killed mouse triggers, especially once App Nap no longer stops the tap in the
/// background. Refreshed at startup and whenever the shortcuts reload.
static MOUSE_BINDS: Lazy<Mutex<(String, String)>> =
    Lazy::new(|| Mutex::new(("none".to_string(), "none".to_string())));

/// Reload the cached mouse binds from the settings DB. Cheap and safe to call anytime;
/// call it at startup and after the user changes a mouse trigger. Falls back to "none".
pub fn refresh_mouse_binds(app: &AppHandle) {
    let read = |key: &str| -> String {
        if let Some(db) = app.try_state::<crate::db::DbState>() {
            if let Ok(conn) = db.0.lock() {
                return conn
                    .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                        r.get::<_, String>(0)
                    })
                    .unwrap_or_else(|_| "none".to_string());
            }
        }
        "none".to_string()
    };
    let instant = read("keybind_mouse_instant");
    let toggle = read("keybind_mouse_toggle");
    if let Ok(mut b) = MOUSE_BINDS.lock() {
        *b = (instant, toggle);
    }
}

/// Whether either mouse trigger is enabled. This is intentionally backed by the
/// in-memory cache so it is safe to use while deciding whether to show macOS's
/// Input Monitoring prompt during startup.
fn has_mouse_bind() -> bool {
    let binds = MOUSE_BINDS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    binds.0 != "none" || binds.1 != "none"
}

pub fn init_hook(
    app: AppHandle,
    audio: Arc<crate::audio::AudioState>,
    pipeline: Arc<crate::pipeline::PipelineState>,
) {
    println!("macOS: keyboard via global-shortcut plugin; starting mouse event tap.");
    // Prime the mouse-bind cache before the tap starts reading it.
    refresh_mouse_binds(&app);
    #[cfg(target_os = "macos")]
    {
        // TCC permissions are attached to the executable/application identity. A
        // grant for `tauri dev` therefore does not grant the packaged LocalFlow.app.
        // If a user already configured a mouse trigger, request the packaged app's
        // own grant at launch. The tap thread below keeps retrying after they allow it.
        if has_mouse_bind() && !crate::mac_permissions::input_monitoring_granted() {
            println!("macOS: requesting Input Monitoring for configured mouse trigger.");
            crate::mac_permissions::prompt_input_monitoring();
        }

        // Prevent App Nap before installing the tap (see disable_app_nap for why).
        macos_mouse::disable_app_nap();
        macos_mouse::spawn_mouse_tap(app, audio, pipeline);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, audio, pipeline); // Linux/other: no mouse hook.
    }
}

#[cfg(target_os = "macos")]
mod macos_mouse {
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::AppHandle;

    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use core_graphics::event::{
        CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
        EventField,
    };

    /// Hold an `NSProcessInfo` activity for the whole process lifetime to keep App Nap
    /// off. This backs up the Info.plist `NSAppSleepDisabled` key: without it, once the
    /// window is hidden and the app goes idle, App Nap throttles the background CFRunLoop
    /// that services our mouse `CGEventTap`, and mouse triggers silently stop working
    /// (keyboard is unaffected — it uses system-level RegisterEventHotKey). Runs once.
    pub fn disable_app_nap() {
        use objc::runtime::Object;
        use objc::{class, msg_send, sel, sel_impl};
        // NSActivityUserInitiated: disables App Nap (+ sudden/automatic termination).
        const NS_ACTIVITY_USER_INITIATED: u64 = 0x00FF_FFFF;
        unsafe {
            let pinfo: *mut Object = msg_send![class!(NSProcessInfo), processInfo];
            let reason: *mut Object = msg_send![
                class!(NSString),
                stringWithUTF8String: b"LocalFlow global mouse hook must stay live\0".as_ptr()
            ];
            let token: *mut Object = msg_send![
                pinfo,
                beginActivityWithOptions: NS_ACTIVITY_USER_INITIATED
                reason: reason
            ];
            // Retain (and never release) so the activity stays active for the app's
            // lifetime; the token is otherwise autoreleased and the activity would end.
            let _: *mut Object = msg_send![token, retain];
        }
    }

    /// Canonical bind name for a mouse event, or None if it's not a button we map.
    fn bind_name(etype: CGEventType, button: i64) -> Option<&'static str> {
        match etype {
            CGEventType::RightMouseDown | CGEventType::RightMouseUp => Some("right"),
            CGEventType::OtherMouseDown | CGEventType::OtherMouseUp => match button {
                2 => Some("middle"),
                3 => Some("button4"),
                4 => Some("button5"),
                _ => None,
            },
            _ => None,
        }
    }

    /// Does the stored bind string refer to this button? (accepts back/forward aliases)
    fn bind_matches(bind: &str, name: &str) -> bool {
        bind == name
            || (bind == "back" && name == "button4")
            || (bind == "forward" && name == "button5")
    }

    pub fn spawn_mouse_tap(
        app: AppHandle,
        audio: Arc<crate::audio::AudioState>,
        pipeline: Arc<crate::pipeline::PipelineState>,
    ) {
        std::thread::spawn(move || {
            // Tracks an in-progress hold (instant) session so the matching button-up
            // stops exactly once.
            let held = Arc::new(Mutex::new(false));

            // Shared cell holding the live tap so its own callback can re-arm it. macOS
            // *disables* an event tap after a slow callback or a sleep/wake cycle and
            // signals this via a TapDisabled* event — if we don't re-enable it there, the
            // tap dies and mouse triggers silently stop until an app restart. Rc/RefCell
            // is safe: creation and every callback run on THIS thread's run loop only.
            let tap_cell: Rc<RefCell<Option<CGEventTap>>> = Rc::new(RefCell::new(None));

            // Retry creation until Input Monitoring is granted, so enabling the permission
            // later starts mouse triggers without needing an app restart.
            let mut logged_denied = false;
            loop {
                // Do not use successful CGEventTap creation as the permission test.
                // Without Input Monitoring, macOS can restrict the event mask/stream to
                // events delivered to this process. That produces the exact misleading
                // symptom where a mouse bind works in LocalFlow's focused window but not
                // in other apps. Preflight the global-listen grant explicitly first.
                if !crate::mac_permissions::input_monitoring_granted() {
                    if super::has_mouse_bind() && !logged_denied {
                        eprintln!(
                            "macOS: Input Monitoring is required for global mouse triggers. \
                             Waiting for the LocalFlow permission… Keyboard shortcuts are unaffected."
                        );
                        logged_denied = true;
                    }
                    std::thread::sleep(Duration::from_secs(2));
                    continue;
                }

                let cb_app = app.clone();
                let cb_audio = audio.clone();
                let cb_pipeline = pipeline.clone();
                let cb_held = held.clone();
                let cb_cell = tap_cell.clone();

                let tap = CGEventTap::new(
                    CGEventTapLocation::Session,
                    CGEventTapPlacement::HeadInsertEventTap,
                    CGEventTapOptions::ListenOnly,
                    vec![
                        CGEventType::OtherMouseDown,
                        CGEventType::OtherMouseUp,
                        CGEventType::RightMouseDown,
                        CGEventType::RightMouseUp,
                    ],
                    move |_proxy, etype, event| {
                        // macOS disabled the tap (timeout or during user input) — re-arm
                        // it immediately so mouse triggers keep working.
                        if matches!(
                            etype,
                            CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput
                        ) {
                            if let Some(t) = cb_cell.borrow().as_ref() {
                                t.enable();
                            }
                            return None;
                        }
                        let button =
                            event.get_integer_value_field(EventField::MOUSE_EVENT_BUTTON_NUMBER);
                        // This closure is invoked from CoreGraphics C code. A Rust panic
                        // unwinding across that FFI boundary is undefined behavior and, in
                        // practice, tears down this run-loop thread — permanently killing
                        // mouse triggers while keyboard shortcuts (a separate OS mechanism)
                        // keep working. Catch any panic so a one-off failure (e.g. a poisoned
                        // mutex left by an unrelated panic elsewhere) can never take the tap
                        // down; handle_mouse also recovers poisoned locks so it won't panic.
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            handle_mouse(&cb_app, &cb_audio, &cb_pipeline, &cb_held, etype, button);
                        }));
                        // ListenOnly tap — never modify/consume; let the click pass through.
                        None
                    },
                );

                match tap {
                    Ok(t) => {
                        *tap_cell.borrow_mut() = Some(t);
                        break;
                    }
                    Err(_) => {
                        if !logged_denied {
                            eprintln!(
                                "macOS: Input Monitoring is granted, but the global mouse event \
                                 tap could not be created. Retrying… Keyboard shortcuts are unaffected."
                            );
                            logged_denied = true;
                        }
                        std::thread::sleep(Duration::from_secs(5));
                    }
                }
            }

            unsafe {
                let cell = tap_cell.borrow();
                let tap = cell.as_ref().unwrap();
                let loop_source = match tap.mach_port.create_runloop_source(0) {
                    Ok(s) => s,
                    Err(_) => {
                        eprintln!("macOS: failed to create run-loop source for mouse tap.");
                        return;
                    }
                };
                CFRunLoop::get_current().add_source(&loop_source, kCFRunLoopCommonModes);
                tap.enable();
                drop(cell); // release the borrow before the callback needs it
                println!("macOS: mouse event tap active.");
                CFRunLoop::run_current(); // blocks this thread for the tap's lifetime
            }
        });
    }

    fn handle_mouse(
        app: &AppHandle,
        audio: &Arc<crate::audio::AudioState>,
        pipeline: &Arc<crate::pipeline::PipelineState>,
        held: &Arc<Mutex<bool>>,
        etype: CGEventType,
        button: i64,
    ) {
        let name = match bind_name(etype, button) {
            Some(n) => n,
            None => return,
        };
        let is_down = matches!(
            etype,
            CGEventType::OtherMouseDown | CGEventType::RightMouseDown
        );

        // Read binds from the in-memory cache — never the DB — so this real-time callback
        // can't block on the DB mutex and get the tap disabled by macOS's timeout.
        // Every lock here recovers from poisoning (`into_inner`) instead of `.unwrap()`:
        // a panic elsewhere in the app must not be able to poison a mutex and make this
        // FFI callback panic, which would kill the tap thread and disable mouse triggers.
        let (mouse_instant, mouse_toggle) = super::MOUSE_BINDS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let is_processing = *pipeline
            .is_processing
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        // Window/recording access must happen on the main thread on macOS, so each
        // action is dispatched there via run_on_main_thread.

        // 1. Instant dictation (hold-to-talk): down starts, up stops.
        if mouse_instant != "none" && bind_matches(&mouse_instant, name) {
            if is_down {
                let mut h = held
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let recording = *audio
                    .is_recording
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if !*h && !is_processing && !recording {
                    *h = true;
                    drop(h);
                    let (a, au) = (app.clone(), audio.clone());
                    let _ = app.run_on_main_thread(move || crate::hook_start_recording(&a, &au));
                }
            } else {
                let was_held = {
                    let mut h = held
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    let v = *h;
                    *h = false;
                    v
                };
                if was_held {
                    let (a, au, p) = (app.clone(), audio.clone(), pipeline.clone());
                    let _ = app
                        .run_on_main_thread(move || crate::hook_stop_and_transcribe(&a, &au, &p));
                }
            }
            return;
        }

        // 2. Toggle dictation: button-down flips recording on/off.
        if mouse_toggle != "none" && bind_matches(&mouse_toggle, name) && is_down && !is_processing
        {
            let (a, au, p) = (app.clone(), audio.clone(), pipeline.clone());
            let _ = app.run_on_main_thread(move || crate::hook_toggle_recording(&a, &au, &p));
        }
    }
}
