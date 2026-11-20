//! Settings → "Remove LocalFlow": delete saved transcriptions, move the app to the
//! Trash, or both.
//!
//! The order and the failure handling live in `run`, which works through the
//! `Remover` trait so tests can use a fake (nothing real is deleted or trashed in
//! tests). `AppRemover` is the real thing. Rules:
//! - Choosing an option deletes nothing; the frontend asks for confirmation first.
//! - Settings, dictionary, notes and downloaded models are kept in every case.
//! - "Both": the app is checked first (a DMG or development build can't be removed,
//!   so nothing is deleted), then transcriptions are deleted, then the app is moved
//!   to the Trash. If that last step fails, the result says the data is gone but
//!   the app stayed. No false success.
//! - The app is moved with Finder's Trash (NSFileManager), never deleted outright,
//!   and only after checking it really is the installed LocalFlow.app.
//! - macOS only for app removal; elsewhere it says so.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const BUNDLE_ID: &str = "com.localflow.desktop";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoveChoice {
    AppAndData,
    AppOnly,
    DataOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemovalOutcome {
    pub data_deleted: bool,
    pub app_removed: bool,
    /// What went wrong, in words for the user. None when everything asked for happened.
    pub error: Option<String>,
}

/// The steps, so `run` can be tested with a fake.
pub trait Remover {
    /// The installed bundle to trash, or why the app can't be removed from here.
    fn locate_app(&self) -> Result<PathBuf, String>;
    fn clear_data(&self) -> Result<(), String>;
    /// Stop recording or transcribing before the app goes.
    fn stop_activity(&self);
    /// Whether launch at login is on.
    fn login_item_enabled(&self) -> bool;
    fn set_login_item(&self, enabled: bool) -> Result<(), String>;
    fn move_to_trash(&self, bundle: &Path) -> Result<(), String>;
}

pub fn run(choice: RemoveChoice, r: &dyn Remover) -> RemovalOutcome {
    let mut out = RemovalOutcome { data_deleted: false, app_removed: false, error: None };
    let wants_app = choice != RemoveChoice::DataOnly;
    let wants_data = choice != RemoveChoice::AppOnly;

    // 1. If the app is to go, make sure it can before touching anything.
    let bundle = if wants_app {
        match r.locate_app() {
            Ok(b) => Some(b),
            Err(why) => {
                out.error = Some(format!("{why} Nothing was deleted."));
                return out;
            }
        }
    } else {
        None
    };

    // 2. Transcriptions.
    if wants_data {
        if let Err(e) = r.clear_data() {
            out.error = Some(format!("Your transcriptions couldn't be deleted, so nothing was removed. ({e})"));
            return out;
        }
        out.data_deleted = true;
    }

    // 3. The app.
    if let Some(bundle) = bundle {
        r.stop_activity();
        let was_on = r.login_item_enabled();
        if was_on {
            if let Err(e) = r.set_login_item(false) {
                out.error = Some(partial(out.data_deleted, &format!("launch at login couldn't be turned off ({e})")));
                return out;
            }
        }
        if let Err(e) = r.move_to_trash(&bundle) {
            if was_on {
                let _ = r.set_login_item(true); // put things back as they were
            }
            out.error = Some(partial(out.data_deleted, &format!("it couldn't be moved to the Trash ({e})")));
            return out;
        }
        out.app_removed = true;
    }
    out
}

fn partial(data_deleted: bool, why: &str) -> String {
    if data_deleted {
        format!("Your transcriptions were deleted, but LocalFlow is still installed: {why}.")
    } else {
        format!("LocalFlow is still installed: {why}. Nothing was deleted.")
    }
}

/// Find and check the installed app bundle from the running executable
/// (`…/LocalFlow.app/Contents/MacOS/<binary>`). Refuses development builds, the app
/// running from a disk image or external volume, macOS's temporary "translocated"
/// copy, and any bundle that isn't LocalFlow.
pub fn validate_bundle(exe: &Path) -> Result<PathBuf, String> {
    if !cfg!(target_os = "macos") {
        return Err("Removing the app from here is only available on macOS for now. Use your system's usual way to uninstall it.".into());
    }
    let p = exe.to_string_lossy();
    if p.contains("/target/debug/") || p.contains("/target/release/") {
        return Err("This is a development build, so there's no installed LocalFlow app to remove.".into());
    }
    if p.contains("/AppTranslocation/") {
        return Err("macOS is running LocalFlow from a temporary copy. Move LocalFlow to Applications, open it from there, then try again.".into());
    }
    if p.starts_with("/Volumes/") {
        return Err("LocalFlow is running from the installer disk image or an external drive. Remove it in Finder instead.".into());
    }
    // exe → MacOS → Contents → LocalFlow.app
    let macos = exe.parent().filter(|d| d.file_name().is_some_and(|n| n == "MacOS"));
    let contents = macos.and_then(Path::parent).filter(|d| d.file_name().is_some_and(|n| n == "Contents"));
    let bundle = contents
        .and_then(Path::parent)
        .filter(|b| b.extension().is_some_and(|e| e == "app"))
        .ok_or("LocalFlow isn't running from an app bundle, so there's nothing to remove.")?;
    let bundle = bundle
        .canonicalize()
        .map_err(|_| "LocalFlow's app bundle couldn't be found.".to_string())?;
    if !bundle.is_dir() {
        return Err("LocalFlow's app bundle couldn't be found.".into());
    }
    if bundle_identifier(&bundle.join("Contents/Info.plist")).as_deref() != Some(BUNDLE_ID) {
        return Err("This doesn't look like the LocalFlow app, so it wasn't touched.".into());
    }
    Ok(bundle)
}

/// CFBundleIdentifier from an XML Info.plist (what Tauri writes).
fn bundle_identifier(plist: &Path) -> Option<String> {
    let text = std::fs::read_to_string(plist).ok()?;
    let after = &text[text.find("<key>CFBundleIdentifier</key>")? + "<key>CFBundleIdentifier</key>".len()..];
    let start = after.find("<string>")? + "<string>".len();
    let end = after[start..].find("</string>")?;
    Some(after[start..start + end].trim().to_string())
}

/// Move `path` to the Trash with Finder's own API (it can be put back from there).
#[cfg(target_os = "macos")]
pub fn trash(path: &Path) -> Result<(), String> {
    use objc::runtime::{Object, BOOL, NO};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::{CStr, CString};

    let c = CString::new(path.to_string_lossy().as_bytes()).map_err(|_| "bad path".to_string())?;
    unsafe {
        let s: *mut Object = msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()];
        let url: *mut Object = msg_send![class!(NSURL), fileURLWithPath: s];
        let fm: *mut Object = msg_send![class!(NSFileManager), defaultManager];
        let mut err: *mut Object = std::ptr::null_mut();
        let ok: BOOL = msg_send![fm, trashItemAtURL: url resultingItemURL: std::ptr::null_mut::<*mut Object>() error: &mut err];
        if ok == NO {
            let mut msg = "unknown error".to_string();
            if !err.is_null() {
                let d: *mut Object = msg_send![err, localizedDescription];
                if !d.is_null() {
                    let u: *const std::os::raw::c_char = msg_send![d, UTF8String];
                    if !u.is_null() {
                        msg = CStr::from_ptr(u).to_string_lossy().into_owned();
                    }
                }
            }
            return Err(msg);
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn trash(_path: &Path) -> Result<(), String> {
    Err("not supported on this system".into())
}

// ─── The real remover ────────────────────────────────────────────────────────

pub struct AppRemover<'a> {
    pub app: &'a tauri::AppHandle,
}

impl Remover for AppRemover<'_> {
    fn locate_app(&self) -> Result<PathBuf, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        validate_bundle(&exe)
    }
    fn clear_data(&self) -> Result<(), String> {
        use tauri::Manager;
        let db = self.app.state::<crate::db::DbState>();
        let mut conn = db.0.lock().map_err(|_| "database busy".to_string())?;
        crate::db::clear_transcription_data(&mut conn)
    }
    fn stop_activity(&self) {
        use tauri::Manager;
        let audio = self.app.state::<std::sync::Arc<crate::audio::AudioState>>();
        if *audio.is_recording.lock().unwrap() {
            crate::audio::stop_capture_internal(&audio);
        }
        if let Some(b) = self.app.get_webview_window("bubble") {
            let _ = b.hide();
        }
    }
    fn login_item_enabled(&self) -> bool {
        use tauri_plugin_autostart::ManagerExt;
        self.app.autolaunch().is_enabled().unwrap_or(false)
    }
    fn set_login_item(&self, enabled: bool) -> Result<(), String> {
        use tauri_plugin_autostart::ManagerExt;
        let a = self.app.autolaunch();
        if enabled { a.enable() } else { a.disable() }.map_err(|e| e.to_string())
    }
    fn move_to_trash(&self, bundle: &Path) -> Result<(), String> {
        trash(bundle)
    }
}

/// Whether the app can be removed from here, and if not, why (for the Settings card).
#[derive(Serialize)]
pub struct RemovalSupport {
    pub app_removable: bool,
    pub reason: Option<String>,
}

#[tauri::command]
pub fn removal_support() -> RemovalSupport {
    match std::env::current_exe().map_err(|e| e.to_string()).and_then(|e| validate_bundle(&e)) {
        Ok(_) => RemovalSupport { app_removable: true, reason: None },
        Err(why) => RemovalSupport { app_removable: false, reason: Some(why) },
    }
}

#[tauri::command]
pub async fn remove_localflow(app: tauri::AppHandle, choice: RemoveChoice) -> Result<RemovalOutcome, String> {
    use tauri::Emitter;
    let handle = app.clone();
    let out = tauri::async_runtime::spawn_blocking(move || run(choice, &AppRemover { app: &handle }))
        .await
        .map_err(|e| e.to_string())?;
    if out.data_deleted {
        let _ = app.emit("history-cleared", ());
    }
    if out.app_removed {
        // Let the window show "Moved to Trash" for a moment, then quit.
        let a = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            a.exit(0);
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Records what was done; each step can be set to fail.
    #[derive(Default)]
    struct Fake {
        app_err: Option<String>,
        data_err: Option<String>,
        login_on: bool,
        login_err: Option<String>,
        trash_err: Option<String>,
        log: RefCell<Vec<String>>,
    }
    impl Remover for Fake {
        fn locate_app(&self) -> Result<PathBuf, String> {
            self.log.borrow_mut().push("locate".into());
            match &self.app_err { Some(e) => Err(e.clone()), None => Ok(PathBuf::from("/Applications/LocalFlow.app")) }
        }
        fn clear_data(&self) -> Result<(), String> {
            self.log.borrow_mut().push("clear".into());
            match &self.data_err { Some(e) => Err(e.clone()), None => Ok(()) }
        }
        fn stop_activity(&self) { self.log.borrow_mut().push("stop".into()); }
        fn login_item_enabled(&self) -> bool { self.login_on }
        fn set_login_item(&self, on: bool) -> Result<(), String> {
            self.log.borrow_mut().push(format!("login:{on}"));
            match &self.login_err { Some(e) if !on => Err(e.clone()), _ => Ok(()) }
        }
        fn move_to_trash(&self, b: &Path) -> Result<(), String> {
            self.log.borrow_mut().push(format!("trash:{}", b.display()));
            match &self.trash_err { Some(e) => Err(e.clone()), None => Ok(()) }
        }
    }
    fn log(f: &Fake) -> Vec<String> { f.log.borrow().clone() }

    #[test]
    fn data_only_never_touches_the_app() {
        let f = Fake::default();
        let out = run(RemoveChoice::DataOnly, &f);
        assert_eq!(out, RemovalOutcome { data_deleted: true, app_removed: false, error: None });
        assert_eq!(log(&f), ["clear"]);
    }

    #[test]
    fn app_only_keeps_the_data() {
        let f = Fake { login_on: true, ..Default::default() };
        let out = run(RemoveChoice::AppOnly, &f);
        assert_eq!(out, RemovalOutcome { data_deleted: false, app_removed: true, error: None });
        assert_eq!(log(&f), ["locate", "stop", "login:false", "trash:/Applications/LocalFlow.app"]);
    }

    #[test]
    fn both_deletes_data_before_removing_the_app() {
        let f = Fake::default();
        let out = run(RemoveChoice::AppAndData, &f);
        assert_eq!(out, RemovalOutcome { data_deleted: true, app_removed: true, error: None });
        assert_eq!(log(&f), ["locate", "clear", "stop", "trash:/Applications/LocalFlow.app"]);
    }

    #[test]
    fn both_with_an_unremovable_app_deletes_nothing() {
        let f = Fake { app_err: Some("This is a development build.".into()), ..Default::default() };
        let out = run(RemoveChoice::AppAndData, &f);
        assert!(!out.data_deleted && !out.app_removed);
        assert!(out.error.unwrap().contains("Nothing was deleted"));
        assert_eq!(log(&f), ["locate"]);
    }

    #[test]
    fn both_stops_if_the_data_cant_be_deleted() {
        let f = Fake { data_err: Some("disk I/O error".into()), ..Default::default() };
        let out = run(RemoveChoice::AppAndData, &f);
        assert!(!out.data_deleted && !out.app_removed);
        assert_eq!(log(&f), ["locate", "clear"], "the app must not be touched");
    }

    #[test]
    fn both_reports_honestly_when_trashing_fails() {
        let f = Fake { login_on: true, trash_err: Some("permission denied".into()), ..Default::default() };
        let out = run(RemoveChoice::AppAndData, &f);
        assert!(out.data_deleted && !out.app_removed);
        let msg = out.error.unwrap();
        assert!(msg.contains("transcriptions were deleted") && msg.contains("still installed"), "{msg}");
        // Launch at login is turned back on.
        assert_eq!(log(&f), ["locate", "clear", "stop", "login:false", "trash:/Applications/LocalFlow.app", "login:true"]);
    }

    #[test]
    fn app_only_stops_if_login_item_cant_be_turned_off() {
        let f = Fake { login_on: true, login_err: Some("launchctl failed".into()), ..Default::default() };
        let out = run(RemoveChoice::AppOnly, &f);
        assert!(!out.app_removed);
        assert!(!log(&f).iter().any(|s| s.starts_with("trash")));
    }

    // ── Bundle checks, on fake bundles in a temporary folder ──

    fn fake_bundle(root: &Path, name: &str, id: &str) -> PathBuf {
        let b = root.join(name);
        std::fs::create_dir_all(b.join("Contents/MacOS")).unwrap();
        std::fs::write(
            b.join("Contents/Info.plist"),
            format!("<plist><dict><key>CFBundleIdentifier</key>\n<string>{id}</string></dict></plist>"),
        )
        .unwrap();
        std::fs::write(b.join("Contents/MacOS/localflow"), "").unwrap();
        b.join("Contents/MacOS/localflow")
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lf-uninstall-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn accepts_the_real_localflow_bundle() {
        let d = tmp("ok");
        let exe = fake_bundle(&d, "LocalFlow.app", BUNDLE_ID);
        let b = validate_bundle(&exe).unwrap();
        assert!(b.ends_with("LocalFlow.app"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn refuses_other_apps_and_odd_places() {
        let d = tmp("bad");
        let other = fake_bundle(&d, "Other.app", "com.example.other");
        assert!(validate_bundle(&other).unwrap_err().contains("doesn't look like the LocalFlow app"));
        assert!(validate_bundle(Path::new("/Volumes/LocalFlow/LocalFlow.app/Contents/MacOS/localflow")).is_err());
        assert!(validate_bundle(Path::new("/private/var/folders/x/AppTranslocation/ABC/d/LocalFlow.app/Contents/MacOS/localflow")).is_err());
        assert!(validate_bundle(Path::new("/Users/me/flowlocal/src-tauri/target/release/localflow")).unwrap_err().contains("development build"));
        assert!(validate_bundle(Path::new("/usr/local/bin/localflow")).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
