/// privacy.rs — Settings → Privacy extras:
/// - auto-delete history after N days (`history_retention_days`, "0" = never),
/// - apps whose dictations are never saved (`nosave_apps`, JSON list of app names),
/// - hide LocalFlow's floating windows from screen sharing (`hide_from_capture`),
/// - lock History behind Touch ID / the Mac password (`history_lock`, macOS only).
use crate::db::DbState;
use rusqlite::Connection;
use serde::Serialize;
use tauri::{Emitter, Manager};

fn read(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).ok()
}

fn write(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        rusqlite::params![key, value],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

// ─── Auto-delete ─────────────────────────────────────────────────────────────

/// Days to keep history; 0 means keep forever (the default).
pub fn retention_days(conn: &Connection) -> u32 {
    read(conn, "history_retention_days").and_then(|v| v.parse().ok()).unwrap_or(0)
}

/// Delete dictations older than the retention period. Returns how many went.
pub fn prune_history(conn: &Connection) -> usize {
    let days = retention_days(conn);
    if days == 0 {
        return 0;
    }
    let n = conn
        .execute(
            "DELETE FROM dictation_history WHERE timestamp < datetime('now', ?1)",
            [format!("-{days} days")],
        )
        .unwrap_or(0);
    if n > 0 {
        // The search index mirrors the table; rebuild it from what's left.
        let _ = conn.execute("INSERT INTO dictation_fts(dictation_fts) VALUES('rebuild')", []);
    }
    n
}

fn prune_and_notify(app: &tauri::AppHandle) {
    let n = app
        .try_state::<DbState>()
        .and_then(|db| db.0.lock().ok().map(|c| prune_history(&c)))
        .unwrap_or(0);
    if n > 0 {
        let _ = app.emit("history-cleared", ());
    }
}

/// Prune now, then once an hour while the app runs.
pub fn start_retention_timer(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        prune_and_notify(&app);
        std::thread::sleep(std::time::Duration::from_secs(3600));
    });
}

#[tauri::command]
pub fn set_history_retention(app: tauri::AppHandle, days: u32) -> Result<(), String> {
    {
        let db = app.try_state::<DbState>().ok_or("Database not ready")?;
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        write(&conn, "history_retention_days", &days.to_string())?;
    }
    prune_and_notify(&app);
    Ok(())
}

// ─── Don't-save apps ─────────────────────────────────────────────────────────

/// Whether dictations into this app should be kept out of history.
pub fn is_nosave_app(conn: &Connection, app_name: &str) -> bool {
    let name = app_name.trim().to_lowercase();
    if name.is_empty() {
        return false;
    }
    read(conn, "nosave_apps")
        .and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
        .unwrap_or_default()
        .iter()
        .any(|a| a.trim().to_lowercase() == name)
}

#[derive(Serialize)]
pub struct KnownApp {
    pub name: String,
    pub exe: String,
}

/// Apps to choose from: the ones open right now plus the ones you've dictated into.
#[tauri::command]
pub fn list_known_apps(app: tauri::AppHandle) -> Vec<KnownApp> {
    let mut out: Vec<KnownApp> = running_apps();
    if let Some(db) = app.try_state::<DbState>() {
        if let Ok(conn) = db.0.lock() {
            if let Ok(mut st) = conn.prepare(
                "SELECT app_name, MAX(app_exe) FROM dictation_history
                 WHERE app_name != '' AND app_name != 'Unknown' GROUP BY app_name",
            ) {
                let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)));
                if let Ok(rows) = rows {
                    for (name, exe) in rows.flatten() {
                        out.push(KnownApp { name, exe });
                    }
                }
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|a| {
        let k = a.name.trim().to_lowercase();
        !k.is_empty() && k != "localflow" && seen.insert(k)
    });
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

#[cfg(target_os = "macos")]
fn running_apps() -> Vec<KnownApp> {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;
    let mut out = Vec::new();
    unsafe {
        let ws: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        let apps: *mut Object = msg_send![ws, runningApplications];
        if apps.is_null() {
            return out;
        }
        let count: usize = msg_send![apps, count];
        for i in 0..count {
            let a: *mut Object = msg_send![apps, objectAtIndex: i];
            let policy: isize = msg_send![a, activationPolicy];
            if policy != 0 {
                continue; // only regular apps with a Dock icon
            }
            let name: *mut Object = msg_send![a, localizedName];
            if name.is_null() {
                continue;
            }
            let p: *const std::os::raw::c_char = msg_send![name, UTF8String];
            if p.is_null() {
                continue;
            }
            let name = CStr::from_ptr(p).to_string_lossy().trim().to_string();
            out.push(KnownApp { name, exe: String::new() });
        }
    }
    out
}

#[cfg(not(target_os = "macos"))]
fn running_apps() -> Vec<KnownApp> {
    Vec::new()
}

// ─── Hide from screen sharing ────────────────────────────────────────────────

/// Windows that float over other apps: the orb / notch island, the copy card and
/// the drag-to-place overlay.
const FLOATING: [&str; 3] = ["bubble", "card", "placer"];

pub fn apply_capture_protection(app: &tauri::AppHandle) {
    let on = app
        .try_state::<DbState>()
        .and_then(|db| db.0.lock().ok().and_then(|c| read(&c, "hide_from_capture")))
        .map(|v| v == "true")
        .unwrap_or(false);
    for label in FLOATING {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.set_content_protected(on);
        }
    }
}

#[tauri::command]
pub fn set_hide_from_capture(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    {
        let db = app.try_state::<DbState>().ok_or("Database not ready")?;
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        write(&conn, "hide_from_capture", if on { "true" } else { "false" })?;
    }
    let ah = app.clone();
    let _ = app.run_on_main_thread(move || apply_capture_protection(&ah));
    Ok(())
}

// ─── History lock ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn history_lock_supported() -> bool {
    cfg!(target_os = "macos")
}

/// Ask for Touch ID (or the Mac's password). Ok(true) when the user passed.
#[tauri::command]
pub async fn unlock_history(reason: String) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || authenticate(&reason))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = reason;
        Ok(true)
    }
}

#[cfg(target_os = "macos")]
fn authenticate(reason: &str) -> Result<bool, String> {
    use block::ConcreteBlock;
    use objc::runtime::{Class, Object, BOOL, NO};
    use objc::{msg_send, sel, sel_impl};

    #[link(name = "LocalAuthentication", kind = "framework")]
    extern "C" {}

    // LAPolicyDeviceOwnerAuthentication: Touch ID, Apple Watch or the login password.
    const POLICY: isize = 2;
    let cls = Class::get("LAContext").ok_or("Touch ID isn't available on this Mac")?;
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    unsafe {
        let ctx: *mut Object = msg_send![cls, new];
        let mut err: *mut Object = std::ptr::null_mut();
        let can: BOOL = msg_send![ctx, canEvaluatePolicy: POLICY error: &mut err];
        if can == NO {
            let _: () = msg_send![ctx, release];
            return Err("This Mac has no Touch ID or password set up".into());
        }
        let c = std::ffi::CString::new(reason).unwrap_or_default();
        let ns: *mut Object = msg_send![objc::class!(NSString), stringWithUTF8String: c.as_ptr()];
        let block = ConcreteBlock::new(move |ok: BOOL, _e: *mut Object| {
            let _ = tx.send(ok != NO);
        })
        .copy();
        let _: () = msg_send![ctx, evaluatePolicy: POLICY localizedReason: ns reply: &*block];
        let res = rx.recv_timeout(std::time::Duration::from_secs(120)).unwrap_or(false);
        let _: () = msg_send![ctx, release];
        Ok(res)
    }
}

// ─── Full-screen apps ────────────────────────────────────────────────────────

/// Whether the frontmost app's window is in macOS full screen. The Dock and menu
/// bar are hidden then, so the orb should sit at the real screen edge.
#[cfg(target_os = "macos")]
pub fn frontmost_fullscreen() -> bool {
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::string::{CFString, CFStringRef};
    use std::ffi::c_void;
    type AX = *const c_void;
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXUIElementCreateApplication(pid: i32) -> AX;
        fn AXUIElementCopyAttributeValue(el: AX, attr: CFStringRef, value: *mut CFTypeRef) -> i32;
        fn AXUIElementSetMessagingTimeout(el: AX, seconds: f32) -> i32;
    }
    unsafe {
        if !AXIsProcessTrusted() {
            return false;
        }
        use objc::runtime::Object;
        use objc::{class, msg_send, sel, sel_impl};
        let ws: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        let front: *mut Object = msg_send![ws, frontmostApplication];
        if front.is_null() {
            return false;
        }
        let pid: i32 = msg_send![front, processIdentifier];
        if pid as u32 == std::process::id() {
            return FULLSCREEN.load(std::sync::atomic::Ordering::SeqCst); // keep as is
        }
        let el = AXUIElementCreateApplication(pid);
        if el.is_null() {
            return false;
        }
        let app = CFType::wrap_under_create_rule(el as CFTypeRef);
        let app_ref = app.as_CFTypeRef() as AX;
        AXUIElementSetMessagingTimeout(app_ref, 0.2);
        let copy = |el: AX, attr: &str| -> Option<CFType> {
            let mut v: CFTypeRef = std::ptr::null();
            let key = CFString::new(attr);
            (AXUIElementCopyAttributeValue(el, key.as_concrete_TypeRef(), &mut v) == 0 && !v.is_null())
                .then(|| CFType::wrap_under_create_rule(v))
        };
        let Some(win) = copy(app_ref, "AXFocusedWindow").or_else(|| copy(app_ref, "AXMainWindow")) else {
            return false;
        };
        copy(win.as_CFTypeRef() as AX, "AXFullScreen")
            .and_then(|v| v.downcast::<CFBoolean>())
            .map(bool::from)
            .unwrap_or(false)
    }
}

#[cfg(not(target_os = "macos"))]
pub fn frontmost_fullscreen() -> bool {
    false
}

pub static FULLSCREEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Watch for the frontmost app entering / leaving full screen and re-place the orb.
pub fn start_fullscreen_watch(app: tauri::AppHandle) {
    if !cfg!(target_os = "macos") {
        return;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(700));
        let now = frontmost_fullscreen();
        if FULLSCREEN.swap(now, std::sync::atomic::Ordering::SeqCst) != now {
            let ah = app.clone();
            let _ = app.run_on_main_thread(move || crate::replace_bubble(&ah));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::db::init_db(&c).unwrap();
        c
    }

    #[test]
    fn never_is_the_default_and_keeps_everything() {
        let c = db();
        c.execute(
            "INSERT INTO dictation_history (timestamp, cleaned_text) VALUES (datetime('now', '-400 days'), 'Old.')",
            [],
        )
        .unwrap();
        assert_eq!(retention_days(&c), 0);
        assert_eq!(prune_history(&c), 0);
    }

    #[test]
    fn pruning_removes_only_older_rows() {
        let c = db();
        c.execute_batch(
            "INSERT INTO dictation_history (timestamp, cleaned_text) VALUES (datetime('now', '-8 days'), 'Old.');
             INSERT INTO dictation_history (timestamp, cleaned_text) VALUES (datetime('now', '-2 days'), 'New.');
             INSERT INTO settings (key, value) VALUES ('history_retention_days', '7');",
        )
        .unwrap();
        assert_eq!(prune_history(&c), 1);
        let left: String = c.query_row("SELECT cleaned_text FROM dictation_history", [], |r| r.get(0)).unwrap();
        assert_eq!(left, "New.");
    }

    #[test]
    fn nosave_matches_app_names_ignoring_case() {
        let c = db();
        c.execute("INSERT INTO settings (key, value) VALUES ('nosave_apps', '[\"1Password\",\"WhatsApp\"]')", [])
            .unwrap();
        assert!(is_nosave_app(&c, "1password"));
        assert!(is_nosave_app(&c, " WhatsApp "));
        assert!(!is_nosave_app(&c, "Notes"));
        assert!(!is_nosave_app(&c, ""));
    }
}
