/// media.rs — "Pause music while dictating" (Settings → Audio input, on by default).
///
/// While the mic is open:
/// - macOS: Spotify / Apple Music are paused if they were playing (and resumed after),
///   and the system volume is turned down to a quarter so anything else (YouTube in a
///   browser, a video call) is quieter. The volume is only put back if you didn't
///   change it yourself in the meantime.
/// - Windows: playback is muted, then unmuted (only if we muted it).
///
/// Volume changes go straight through CoreAudio (instant), so the stop sound plays at
/// normal volume. Talking to Spotify / Music uses AppleScript on a worker thread, in
/// order, so a quick tap can't resume before the pause went through.
use once_cell::sync::OnceCell;
use std::sync::Mutex;
use tauri::Manager;

static APP: OnceCell<tauri::AppHandle> = OnceCell::new();

pub fn init(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
}

/// The setting, read fresh each dictation. Missing = on.
fn enabled() -> bool {
    let Some(app) = APP.get() else { return false };
    let Some(db) = app.try_state::<crate::db::DbState>() else { return true };
    let Ok(conn) = db.0.lock() else { return true };
    conn.query_row("SELECT value FROM settings WHERE key = 'pause_media'", [], |r| r.get::<_, String>(0))
        .map(|v| v != "false")
        .unwrap_or(true)
}

#[derive(Default)]
struct Session {
    active: bool,
    /// (volume before, volume we set) when we turned it down.
    ducked: Option<(f32, f32)>,
    #[cfg(windows)]
    muted: bool,
}

static SESSION: Mutex<Session> = Mutex::new(Session {
    active: false,
    ducked: None,
    #[cfg(windows)]
    muted: false,
});

/// The mic just opened.
pub fn begin() {
    if !enabled() {
        return;
    }
    if let Ok(mut s) = SESSION.lock() {
        if s.active {
            return;
        }
        s.active = true;
    }
    #[cfg(target_os = "macos")]
    {
        mac::send(mac::Job::Pause);
        // Turn down after the start sound has played, so it isn't quieter too.
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(180));
            let Ok(mut s) = SESSION.lock() else { return };
            if !s.active || s.ducked.is_some() {
                return;
            }
            if let Some(v) = mac::volume() {
                if v > 0.02 {
                    let low = (v * 0.25).max(0.02);
                    if mac::set_volume(low) {
                        s.ducked = Some((v, low));
                    }
                }
            }
        });
    }
    #[cfg(windows)]
    {
        if let Ok(mut s) = SESSION.lock() {
            s.muted = crate::audio::set_master_mute(true).is_ok();
        }
    }
}

/// The mic just closed: put things back.
pub fn end() {
    let Ok(mut s) = SESSION.lock() else { return };
    if !s.active {
        return;
    }
    s.active = false;
    #[cfg(target_os = "macos")]
    {
        if let Some((before, ours)) = s.ducked.take() {
            // Only if the volume is still what we set: you may have changed it.
            if mac::volume().map(|now| (now - ours).abs() < 0.02).unwrap_or(false) {
                mac::set_volume(before);
            }
        }
        mac::send(mac::Job::Resume);
    }
    #[cfg(windows)]
    {
        if std::mem::take(&mut s.muted) {
            let _ = crate::audio::set_master_mute(false);
        }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::mpsc::{channel, Sender};
    use std::sync::Mutex;

    pub enum Job {
        Pause,
        Resume,
    }

    static WORKER: Mutex<Option<Sender<Job>>> = Mutex::new(None);

    /// Players we can pause and resume exactly (bundle id).
    const PLAYERS: [&str; 2] = ["com.spotify.client", "com.apple.Music"];

    pub fn send(job: Job) {
        let Ok(mut w) = WORKER.lock() else { return };
        if w.is_none() {
            let (tx, rx) = channel::<Job>();
            std::thread::spawn(move || {
                let mut paused: Vec<&'static str> = Vec::new();
                for job in rx {
                    match job {
                        Job::Pause => {
                            for id in PLAYERS {
                                if is_running(id) && pause_if_playing(id) {
                                    paused.push(id);
                                }
                            }
                        }
                        Job::Resume => {
                            for id in paused.drain(..) {
                                osascript(&format!("tell application id \"{id}\" to play"));
                            }
                        }
                    }
                }
            });
            *w = Some(tx);
        }
        if let Some(tx) = w.as_ref() {
            let _ = tx.send(job);
        }
    }

    /// Never launches the app: AppleScript `tell` would start it if it isn't open.
    fn is_running(bundle_id: &str) -> bool {
        use objc::runtime::Object;
        use objc::{class, msg_send, sel, sel_impl};
        let Ok(c) = std::ffi::CString::new(bundle_id) else { return false };
        unsafe {
            let ns: *mut Object = msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()];
            let apps: *mut Object =
                msg_send![class!(NSRunningApplication), runningApplicationsWithBundleIdentifier: ns];
            if apps.is_null() {
                return false;
            }
            let n: usize = msg_send![apps, count];
            n > 0
        }
    }

    fn pause_if_playing(bundle_id: &str) -> bool {
        let script = format!(
            "tell application id \"{bundle_id}\"\n\
             if player state is playing then\n\
             pause\n\
             return \"paused\"\n\
             end if\n\
             end tell\n\
             return \"\""
        );
        osascript(&script).trim() == "paused"
    }

    fn osascript(script: &str) -> String {
        std::process::Command::new("/usr/bin/osascript")
            .args(["-e", script])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default()
    }

    // ── System output volume (CoreAudio) ──

    #[repr(C)]
    struct Address {
        selector: u32,
        scope: u32,
        element: u32,
    }

    const fn fourcc(s: &[u8; 4]) -> u32 {
        ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | s[3] as u32
    }

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyData(
            id: u32,
            addr: *const Address,
            qsize: u32,
            qdata: *const std::ffi::c_void,
            size: *mut u32,
            data: *mut std::ffi::c_void,
        ) -> i32;
    }
    #[link(name = "AudioToolbox", kind = "framework")]
    extern "C" {
        fn AudioHardwareServiceGetPropertyData(
            id: u32,
            addr: *const Address,
            qsize: u32,
            qdata: *const std::ffi::c_void,
            size: *mut u32,
            data: *mut std::ffi::c_void,
        ) -> i32;
        fn AudioHardwareServiceSetPropertyData(
            id: u32,
            addr: *const Address,
            qsize: u32,
            qdata: *const std::ffi::c_void,
            size: u32,
            data: *const std::ffi::c_void,
        ) -> i32;
    }

    fn output_device() -> Option<u32> {
        let addr = Address { selector: fourcc(b"dOut"), scope: fourcc(b"glob"), element: 0 };
        let mut dev: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let err = unsafe {
            AudioObjectGetPropertyData(1, &addr, 0, std::ptr::null(), &mut size, &mut dev as *mut u32 as *mut _)
        };
        (err == 0 && dev != 0).then_some(dev)
    }

    const VOLUME: Address = Address { selector: fourcc(b"vmvc"), scope: fourcc(b"outp"), element: 0 };

    pub fn volume() -> Option<f32> {
        let dev = output_device()?;
        let mut v: f32 = 0.0;
        let mut size = std::mem::size_of::<f32>() as u32;
        let err = unsafe {
            AudioHardwareServiceGetPropertyData(dev, &VOLUME, 0, std::ptr::null(), &mut size, &mut v as *mut f32 as *mut _)
        };
        (err == 0).then_some(v)
    }

    pub fn set_volume(v: f32) -> bool {
        let Some(dev) = output_device() else { return false };
        let v = v.clamp(0.0, 1.0);
        let err = unsafe {
            AudioHardwareServiceSetPropertyData(
                dev,
                &VOLUME,
                0,
                std::ptr::null(),
                std::mem::size_of::<f32>() as u32,
                &v as *const f32 as *const _,
            )
        };
        err == 0
    }
}
