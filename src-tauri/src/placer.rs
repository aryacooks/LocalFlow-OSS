/// placer.rs — the on-screen guide shown while the orb is being dragged.
///
/// A transparent, click-through window covers the work area of the screen the orb is
/// on. It draws the 8 spots the orb can snap to, highlights the one it will land in,
/// and shows a short "drop it on a spot" message. It is created hidden at startup and
/// only shown during a drag, so it costs nothing otherwise.
use once_cell::sync::Lazy;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

use crate::placement;

#[derive(Clone, serde::Serialize)]
pub struct Spot {
    id: &'static str,
    /// Centre and diameter, logical px inside the placer window.
    x: f64,
    y: f64,
    size: f64,
}

#[derive(Clone, Default, serde::Serialize)]
pub struct Layout {
    spots: Vec<Spot>,
    active: Option<&'static str>,
    /// Placement mode (opened by clicking the orb): spots are clickable and Esc
    /// cancels. Otherwise (during a drag) the guide is click-through.
    interactive: bool,
}

#[derive(Default)]
struct State {
    layout: Layout,
    /// Work area the placer currently covers (physical), to notice screen changes.
    area: Option<(i64, i64, i64, i64)>,
    visible: bool,
}

static STATE: Lazy<Mutex<State>> = Lazy::new(|| Mutex::new(State::default()));

/// Create the (hidden) guide window. Call once from `setup`.
pub fn create(app: &tauri::AppHandle) {
    let built = tauri::WebviewWindowBuilder::new(app, "placer", tauri::WebviewUrl::App("/placer".into()))
        .title("")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build();
    match built {
        Ok(w) => {
            let _ = w.set_focusable(false);
            let _ = w.set_ignore_cursor_events(true);
        }
        Err(e) => eprintln!("placer: could not create guide window: {e}"),
    }
}

/// Called on every drag step with the orb box centre in physical px: show the guide on
/// that screen (moving it if the orb crossed to another screen) and highlight the spot
/// the orb would snap to.
pub fn update(app: &tauri::AppHandle, bubble: &tauri::WebviewWindow, cx: f64, cy: f64) {
    show_at(app, bubble, cx, cy, false);
}

/// Placement mode: show the guide around the orb's screen, clickable and focused so
/// Esc works. The current spot is highlighted.
pub fn enter_mode(app: &tauri::AppHandle) {
    let Some(b) = app.get_webview_window("bubble") else { return };
    let (Ok(pos), Ok(size)) = (b.outer_position(), b.outer_size()) else { return };
    let cx = pos.x as f64 + size.width as f64 / 2.0;
    let cy = pos.y as f64 + size.height as f64 / 2.0;
    show_at(app, &b, cx, cy, true);
}

fn show_at(app: &tauri::AppHandle, bubble: &tauri::WebviewWindow, cx: f64, cy: f64, interactive: bool) {
    let Some(w) = app.get_webview_window("placer") else { return };
    let Some(monitor) = crate::monitor_at(bubble, cx, cy) else { return };
    let sf = monitor.scale_factor();
    let area = crate::work_area(&monitor);
    let scale = crate::adaptive_scale_for(bubble, &monitor);
    let orb = (placement::ORB_BOX * scale).round();
    let margin = placement::EDGE_MARGIN * scale;
    let active = placement::nearest_spot(area, orb, margin, cx, cy);

    let Ok(mut st) = STATE.lock() else { return };
    let key = (area.x as i64, area.y as i64, area.w as i64, area.h as i64);
    let moved_screen = st.area != Some(key);
    if moved_screen {
        st.layout.spots = placement::SPOTS
            .iter()
            .map(|&id| {
                let (x, y) = placement::orb_origin(id, area, orb, margin, 0.0, 0.0);
                Spot {
                    id,
                    x: (x + orb / 2.0 - area.x) / sf,
                    y: (y + orb / 2.0 - area.y) / sf,
                    size: orb / sf,
                }
            })
            .collect();
        st.area = Some(key);
        let _ = w.set_size(tauri::Size::Physical(tauri::PhysicalSize {
            width: area.w as u32,
            height: area.h as u32,
        }));
        let _ = w.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: area.x as i32,
            y: area.y as i32,
        }));
    }
    let changed = moved_screen
        || st.layout.active != Some(active)
        || !st.visible
        || st.layout.interactive != interactive;
    st.layout.active = Some(active);
    let mode_changed = st.layout.interactive != interactive;
    st.layout.interactive = interactive;
    if mode_changed || !st.visible {
        let _ = w.set_ignore_cursor_events(!interactive);
        let _ = w.set_focusable(interactive);
    }
    if !st.visible || mode_changed {
        st.visible = true;
        let _ = w.show();
        if interactive {
            let _ = w.set_focus(); // so Esc reaches the guide
        }
        // Keep the orb above the guide: re-assert its always-on-top so it is
        // re-ordered to the front of that level.
        let _ = bubble.set_always_on_top(false);
        let _ = bubble.set_always_on_top(true);
    }
    if changed {
        let _ = app.emit_to("placer", "placer-layout", st.layout.clone());
    }
}

pub fn hide(app: &tauri::AppHandle) {
    let (was_visible, was_interactive) = STATE
        .lock()
        .map(|mut st| {
            let v = (st.visible, st.layout.interactive);
            st.visible = false;
            st.layout.active = None;
            st.layout.interactive = false;
            v
        })
        .unwrap_or((false, false));
    if let Some(w) = app.get_webview_window("placer") {
        let _ = w.hide();
        let _ = w.set_ignore_cursor_events(true);
        let _ = w.set_focusable(false);
    }
    if was_visible {
        let _ = app.emit("placer-closed", ());
    }
    // Placement mode took focus (for Esc); give it back to the app the user was in,
    // unless they were in LocalFlow's own window.
    #[cfg(target_os = "macos")]
    if was_interactive {
        let main_focused = app
            .get_webview_window("main")
            .map(|m| m.is_visible().unwrap_or(false) && m.is_focused().unwrap_or(false))
            .unwrap_or(false);
        if !main_focused {
            let _ = app.run_on_main_thread(|| unsafe {
                use objc::runtime::Object;
                use objc::{class, msg_send, sel, sel_impl};
                let ns_app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
                let _: () = msg_send![ns_app, deactivate];
            });
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = was_interactive;
}

pub fn is_open() -> bool {
    STATE.lock().map(|s| s.visible).unwrap_or(false)
}

/// Click on the orb: open placement mode, or close it if it's already open.
#[tauri::command]
pub fn toggle_placing(app: tauri::AppHandle) -> bool {
    if is_open() {
        hide(&app);
        false
    } else {
        enter_mode(&app);
        true
    }
}

/// Esc / click outside the spots.
#[tauri::command]
pub fn cancel_placing(app: tauri::AppHandle) {
    hide(&app);
}

/// A spot was clicked in placement mode: move the orb there.
#[tauri::command]
pub fn place_at_spot(app: tauri::AppHandle, spot: String) -> Result<(), String> {
    if !placement::is_spot(&spot) {
        return Err(format!("Unknown spot: {spot}"));
    }
    hide(&app);
    crate::store_placement(&app, &spot, 0.0, 0.0)?;
    crate::show_bubble_window(&app);
    Ok(())
}

/// Current layout, for the guide page when it (re)loads.
#[tauri::command]
pub fn get_placer_layout() -> Layout {
    STATE.lock().map(|s| s.layout.clone()).unwrap_or_default()
}
