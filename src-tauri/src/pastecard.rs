/// pastecard.rs — the "nothing was pasted" card.
///
/// When a dictation finishes but there was no text box to type into (or the paste
/// failed), a small LocalFlow card appears with the text and a Copy button, so the
/// words aren't lost. It sits next to the orb, under the notch in notch mode, or at
/// the bottom centre when the animation is off. It never takes focus.
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

use crate::placement;

/// 20% smaller than the design size; the page scales itself to match (zoom 0.8).
const CARD_W: f64 = 320.0;
const CARD_H: f64 = 186.0;
const GAP: f64 = 8.0;
/// Seconds the card stays up (the clock pauses while the pointer is over it).
const LIFETIME: f64 = 10.0;

/// Bumped on every show/hide so an older countdown stops itself.
static GEN: AtomicU64 = AtomicU64::new(0);
/// Whether LocalFlow's own window was the one in use when the card appeared.
static MAIN_WAS_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

static TEXT: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

/// Create the hidden card window. Call once from `setup`.
pub fn create(app: &tauri::AppHandle) {
    let built = tauri::WebviewWindowBuilder::new(app, "card", tauri::WebviewUrl::App("/card".into()))
        .title("")
        .inner_size(CARD_W, CARD_H)
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
        }
        Err(e) => eprintln!("pastecard: could not create window: {e}"),
    }
}

/// Show the card with `text`.
pub fn show(app: &tauri::AppHandle, text: &str) {
    if text.trim().is_empty() {
        return;
    }
    if let Ok(mut t) = TEXT.lock() {
        *t = Some(text.to_string());
    }
    let Some(w) = app.get_webview_window("card") else { return };
    let main_focused = app
        .get_webview_window("main")
        .map(|m| m.is_visible().unwrap_or(false) && m.is_focused().unwrap_or(false))
        .unwrap_or(false);
    MAIN_WAS_ACTIVE.store(main_focused, Ordering::SeqCst);
    if let Some((x, y, sf)) = position(app) {
        let _ = w.set_size(tauri::Size::Physical(tauri::PhysicalSize {
            width: (CARD_W * sf).round() as u32,
            height: (CARD_H * sf).round() as u32,
        }));
        let _ = w.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: x.round() as i32,
            y: y.round() as i32,
        }));
    }
    crate::notch::join_all_spaces(&w);
    let _ = w.show();
    let _ = w.set_always_on_top(true);
    let _ = app.emit_to("card", "paste-card", text);
    start_countdown(app.clone());
}

/// Hide the card after LIFETIME seconds of the pointer not being over it. Runs here
/// rather than in the webview: a non-focused window's page doesn't reliably get timer
/// ticks or mouse-leave events. Sends (fraction left, paused) for the countdown ring.
fn start_countdown(app: tauri::AppHandle) {
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        let tick = 0.1;
        let mut left = LIFETIME;
        loop {
            std::thread::sleep(std::time::Duration::from_millis((tick * 1000.0) as u64));
            if GEN.load(Ordering::SeqCst) != gen {
                return;
            }
            let Some(w) = app.get_webview_window("card") else { return };
            if !w.is_visible().unwrap_or(false) {
                return;
            }
            let hovered = match (app.cursor_position(), w.outer_position(), w.outer_size()) {
                (Ok(c), Ok(p), Ok(s)) => {
                    c.x >= p.x as f64
                        && c.x < p.x as f64 + s.width as f64
                        && c.y >= p.y as f64
                        && c.y < p.y as f64 + s.height as f64
                }
                _ => false,
            };
            if !hovered {
                left -= tick;
            }
            let _ = app.emit_to("card", "paste-card-left", ((left / LIFETIME).max(0.0), hovered));
            if left <= 0.0 {
                GEN.fetch_add(1, Ordering::SeqCst);
                let _ = w.hide();
                return;
            }
        }
    });
}

/// Physical top-left for the card and the monitor's DPI scale.
fn position(app: &tauri::AppHandle) -> Option<(f64, f64, f64)> {
    let b = app.get_webview_window("bubble")?;
    let monitor = b
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| b.primary_monitor().ok().flatten())?;
    let sf = monitor.scale_factor();
    let area = crate::work_area(&monitor);
    let (cw, ch, gap) = (CARD_W * sf, CARD_H * sf, GAP * sf);
    let clamp = |x: f64, y: f64| {
        (
            x.clamp(area.x + gap, (area.x + area.w - cw - gap).max(area.x)),
            y.clamp(area.y + gap, (area.y + area.h - ch - gap).max(area.y)),
        )
    };
    let centred_x = area.x + (area.w - cw) / 2.0;

    if crate::bubble_hidden(app) {
        let (x, y) = clamp(centred_x, area.y + area.h - ch - 24.0 * sf);
        return Some((x, y, sf));
    }
    if crate::bubble_is_notch(app) {
        let (x, y) = clamp(centred_x, area.y + gap);
        return Some((x, y, sf));
    }
    // Next to the orb, on the side facing the middle of the screen.
    let (spot, nudge, nudge_y) = crate::saved_placement(app);
    let scale = crate::adaptive_scale_for(&b, &monitor);
    let orb = (placement::ORB_BOX * scale).round();
    let (ox, oy) = placement::orb_origin_free(
        &spot,
        area,
        crate::free_area(&monitor),
        orb,
        placement::EDGE_MARGIN * scale,
        nudge * sf,
        nudge_y * sf,
    );
    let mut parts = spot.chars();
    let (row, col) = (parts.next().unwrap_or('b'), parts.next().unwrap_or('r'));
    let x = match col {
        'l' => ox,
        'r' => ox + orb - cw,
        _ => ox + orb / 2.0 - cw / 2.0,
    };
    let y = match row {
        't' => oy + orb + gap,
        _ => oy - ch - gap,
    };
    let (x, y) = clamp(x, y);
    Some((x, y, sf))
}

#[tauri::command]
pub fn get_paste_card() -> Option<String> {
    TEXT.lock().ok().and_then(|t| t.clone())
}

#[tauri::command]
pub fn hide_paste_card(app: tauri::AppHandle) {
    GEN.fetch_add(1, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("card") {
        let _ = w.hide();
    }
    give_focus_back(&app);
}

/// Clicking the card makes macOS activate LocalFlow (and raise its settings window).
/// Unless the user was really in that window, hand focus straight back to the app
/// they were dictating into.
fn give_focus_back(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let main_was_used = MAIN_WAS_ACTIVE.load(Ordering::SeqCst);
        let main_visible = app
            .get_webview_window("main")
            .map(|m| m.is_visible().unwrap_or(false))
            .unwrap_or(false);
        if !(main_was_used && main_visible) {
            let _ = app.run_on_main_thread(|| unsafe {
                use objc::runtime::Object;
                use objc::{class, msg_send, sel, sel_impl};
                let nsapp: *mut Object = msg_send![class!(NSApplication), sharedApplication];
                if !nsapp.is_null() {
                    let _: () = msg_send![nsapp, deactivate];
                }
            });
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}
