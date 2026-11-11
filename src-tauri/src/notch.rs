/// notch.rs — the "Notch island" bubble style.
///
/// Instead of a floating mic, the bubble window sits flush against the top of the
/// screen, centred on the MacBook notch. Idle it's fully transparent, so the notch looks
/// untouched; while dictating, the React side grows black "wings" out of the notch's
/// sides (mic dot on the left, voice wave on the right).
///
/// The window must sit ABOVE the menu bar (a normal always-on-top window sits below it)
/// and must ignore the mouse, so it never eats clicks on menu-bar items next to the
/// notch. Screens without a notch get a notch-sized island at the same spot.
use once_cell::sync::Lazy;
use std::sync::Mutex;

/// Notch size in logical points, plus the size of the screen that has it (used to find
/// the matching Tauri monitor).
#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct NotchGeometry {
    pub width: f64,
    pub height: f64,
    pub has_notch: bool,
    pub screen_w: f64,
    pub screen_h: f64,
}

/// Fallback for displays with no notch: roughly a 14" MacBook notch.
const FALLBACK: NotchGeometry = NotchGeometry {
    width: 186.0,
    height: 32.0,
    has_notch: false,
    screen_w: 0.0,
    screen_h: 0.0,
};

/// How far the island may grow out of each side of the notch, in points. The window is
/// sized for the widest state; the React side animates within it.
pub const WING: f64 = 76.0;
/// Extra transparent room under the notch, for the island's soft shadow.
pub const BOTTOM_PAD: f64 = 10.0;

static GEOMETRY: Lazy<Mutex<Option<NotchGeometry>>> = Lazy::new(|| Mutex::new(None));

/// Read the notch from NSScreen. Must run on the main thread (AppKit); call it from
/// `setup`. The result is cached — the built-in display's notch never changes.
pub fn init() {
    let g = detect().unwrap_or(FALLBACK);
    if let Ok(mut slot) = GEOMETRY.lock() {
        *slot = Some(g);
    }
}

pub fn geometry() -> NotchGeometry {
    GEOMETRY.lock().ok().and_then(|g| *g).unwrap_or(FALLBACK)
}

/// Window size (logical points) for notch mode.
pub fn window_size() -> (f64, f64) {
    let g = geometry();
    (g.width + 2.0 * WING, g.height + BOTTOM_PAD)
}

#[cfg(target_os = "macos")]
mod ffi {
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct NSPoint {
        pub x: f64,
        pub y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct NSSize {
        pub width: f64,
        pub height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct NSRect {
        pub origin: NSPoint,
        pub size: NSSize,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct NSEdgeInsets {
        pub top: f64,
        pub left: f64,
        pub bottom: f64,
        pub right: f64,
    }
}

#[cfg(target_os = "macos")]
fn detect() -> Option<NotchGeometry> {
    use ffi::{NSEdgeInsets, NSRect};
    use objc::runtime::{Object, BOOL, NO};
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        let screens: *mut Object = msg_send![class!(NSScreen), screens];
        if screens.is_null() {
            return None;
        }
        let count: usize = msg_send![screens, count];
        for i in 0..count {
            let s: *mut Object = msg_send![screens, objectAtIndex: i];
            // safeAreaInsets / auxiliaryTop*Area are macOS 12+.
            let ok: BOOL = msg_send![s, respondsToSelector: sel!(auxiliaryTopLeftArea)];
            if ok == NO {
                continue;
            }
            let insets: NSEdgeInsets = msg_send![s, safeAreaInsets];
            if insets.top <= 0.0 {
                continue; // no notch on this screen
            }
            let frame: NSRect = msg_send![s, frame];
            let left: NSRect = msg_send![s, auxiliaryTopLeftArea];
            let right: NSRect = msg_send![s, auxiliaryTopRightArea];
            let width = frame.size.width - left.size.width - right.size.width;
            if width <= 0.0 || width > frame.size.width / 2.0 {
                continue;
            }
            return Some(NotchGeometry {
                width,
                height: insets.top,
                has_notch: true,
                screen_w: frame.size.width,
                screen_h: frame.size.height,
            });
        }
        None
    }
}

#[cfg(not(target_os = "macos"))]
fn detect() -> Option<NotchGeometry> {
    None
}

/// Put the bubble window into (or out of) notch mode: above the menu bar, on every
/// Space and over full-screen apps, and click-through.
///
/// Tauri queues its own window calls (show, always-on-top, size) on the main thread and
/// they can land after ours, resetting the level to "floating" and the position to the
/// config default. So the AppKit part runs now AND again shortly after; in notch mode
/// the idle island is transparent, so the re-apply is invisible.
pub fn apply_window_mode(b: &tauri::WebviewWindow, notch: bool) {
    let _ = b.set_ignore_cursor_events(notch);

    #[cfg(target_os = "macos")]
    {
        apply_appkit(b, notch);
        let win = b.clone();
        std::thread::spawn(move || {
            for delay in [120u64, 600] {
                std::thread::sleep(std::time::Duration::from_millis(delay));
                apply_appkit(&win, notch);
            }
        });
    }
}

#[cfg(target_os = "macos")]
fn apply_appkit(b: &tauri::WebviewWindow, notch: bool) {
    let win = b.clone();
    let _ = b.run_on_main_thread(move || {
        use objc::runtime::Object;
        use objc::{msg_send, sel, sel_impl};
        let Ok(ptr) = win.ns_window() else { return };
        let ns: *mut Object = ptr as *mut Object;
        if ns.is_null() {
            return;
        }
        unsafe {
            let num: i64 = msg_send![ns, windowNumber];
            crate::tint::set_window_id(num.max(0) as u32);
            if !notch {
                return; // Tauri's always-on-top level is right for the floating orb.
            }
            // NSMainMenuWindowLevel (24) + 3: above the menu bar and status items.
            let _: () = msg_send![ns, setLevel: 27i64];
            // canJoinAllSpaces | stationary | ignoresCycle | fullScreenAuxiliary
            let behavior: u64 = (1 << 0) | (1 << 4) | (1 << 6) | (1 << 8);
            let current: u64 = msg_send![ns, collectionBehavior];
            let _: () = msg_send![ns, setCollectionBehavior: current | behavior];
            let _: () = msg_send![ns, setHasShadow: false];
            pin_to_notch(ns);
        }
    });
}

/// Re-pin after anything moves or resizes the window while in notch mode.
#[cfg(target_os = "macos")]
pub fn repin(b: &tauri::WebviewWindow) {
    apply_appkit(b, true);
}

/// Put the window flush with the very top of the notch screen. Tauri's set_position
/// goes through `setFrameTopLeftPoint:`, which AppKit clamps to below the menu bar, so
/// the frame is set directly here (main thread only).
#[cfg(target_os = "macos")]
unsafe fn pin_to_notch(ns: *mut objc::runtime::Object) {
    use ffi::{NSEdgeInsets, NSPoint, NSRect, NSSize};
    use objc::runtime::{Object, BOOL, NO, YES};
    use objc::{class, msg_send, sel, sel_impl};

    let screens: *mut Object = msg_send![class!(NSScreen), screens];
    if screens.is_null() {
        return;
    }
    let count: usize = msg_send![screens, count];
    if count == 0 {
        return;
    }
    // The notched screen if there is one, else the primary (index 0).
    let mut target: *mut Object = msg_send![screens, objectAtIndex: 0usize];
    for i in 0..count {
        let s: *mut Object = msg_send![screens, objectAtIndex: i];
        let ok: BOOL = msg_send![s, respondsToSelector: sel!(safeAreaInsets)];
        if ok == NO {
            continue;
        }
        let insets: NSEdgeInsets = msg_send![s, safeAreaInsets];
        if insets.top > 0.0 {
            target = s;
            break;
        }
    }
    let sf: NSRect = msg_send![target, frame];
    let (w, h) = window_size();
    let frame = NSRect {
        origin: NSPoint {
            x: (sf.origin.x + (sf.size.width - w) / 2.0).round(),
            // Cocoa's origin is bottom-left: top edge of the window = top of the screen.
            y: sf.origin.y + sf.size.height - h,
        },
        size: NSSize { width: w, height: h },
    };
    let cur: NSRect = msg_send![ns, frame];
    let same = (cur.origin.x - frame.origin.x).abs() < 0.5
        && (cur.origin.y - frame.origin.y).abs() < 0.5
        && (cur.size.width - w).abs() < 0.5
        && (cur.size.height - h).abs() < 0.5;
    if !same {
        let _: () = msg_send![ns, setFrame: frame display: YES];
    }
}

/// Pick the monitor that has the notch (matched by logical size), else the primary.
pub fn notch_monitor(b: &tauri::WebviewWindow) -> Option<tauri::Monitor> {
    let g = geometry();
    if g.has_notch {
        if let Ok(monitors) = b.available_monitors() {
            for m in monitors {
                let sf = m.scale_factor();
                let w = m.size().width as f64 / sf;
                let h = m.size().height as f64 / sf;
                if (w - g.screen_w).abs() < 2.0 && (h - g.screen_h).abs() < 2.0 {
                    return Some(m);
                }
            }
        }
    }
    b.primary_monitor().ok().flatten().or_else(|| b.current_monitor().ok().flatten())
}
