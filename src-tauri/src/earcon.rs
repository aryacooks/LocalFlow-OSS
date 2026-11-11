/// earcon.rs — UI sound effects.
///
/// The sounds are short WAV files in `src-tauri/sounds/`, compiled into the binary. They
/// were designed to sit with Wispr Flow / Willow style cues: short (70–180 ms), low
/// (250–600 Hz) and soft, with the start a step higher than the stop so the pair reads
/// as "on" then "off". The user picks a set in Settings → Display.
///
/// Playback is native per OS, so `cpal` stays recording-only: NSSound on macOS (each
/// sound decoded once and kept, so a start cue lands on the key press instead of after
/// a process launch), PlaySoundW on Windows, and paplay/aplay elsewhere.
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

/// Master switch for UI sounds, toggled from Settings via `set_earcons_enabled`.
static SOUNDS_ENABLED: AtomicBool = AtomicBool::new(true);

pub fn set_sounds_enabled(enabled: bool) {
    SOUNDS_ENABLED.store(enabled, Ordering::Relaxed);
}

fn sounds_enabled() -> bool {
    SOUNDS_ENABLED.load(Ordering::Relaxed)
}

struct SoundSet {
    id: &'static str,
    start: &'static [u8],
    stop: &'static [u8],
}

/// Selectable sets. The first is the default.
const SETS: &[SoundSet] = &[
    SoundSet {
        id: "wood-low",
        start: include_bytes!("../sounds/wood-low-start.wav"),
        stop: include_bytes!("../sounds/wood-low-stop.wav"),
    },
    SoundSet {
        id: "wood",
        start: include_bytes!("../sounds/wood-start.wav"),
        stop: include_bytes!("../sounds/wood-stop.wav"),
    },
    SoundSet {
        id: "wood-fifth",
        start: include_bytes!("../sounds/wood-fifth-start.wav"),
        stop: include_bytes!("../sounds/wood-fifth-stop.wav"),
    },
    SoundSet {
        id: "bump",
        start: include_bytes!("../sounds/bump-start.wav"),
        stop: include_bytes!("../sounds/bump-stop.wav"),
    },
];

pub const DEFAULT_SOUND_SET: &str = "wood-low";

/// Shared by every set: a dull two-step down, quieter than stop, so a discarded
/// recording never sounds like a finished one.
static CANCEL_WAV: &[u8] = include_bytes!("../sounds/cancel.wav");

static ACTIVE_SET: AtomicU8 = AtomicU8::new(0);

/// Select a sound set by id. Unknown ids fall back to the default.
pub fn set_sound_set(id: &str) {
    let idx = SETS.iter().position(|s| s.id == id).unwrap_or(0);
    ACTIVE_SET.store(idx as u8, Ordering::Relaxed);
}

pub fn is_known_sound_set(id: &str) -> bool {
    SETS.iter().any(|s| s.id == id)
}

fn active() -> &'static SoundSet {
    &SETS[ACTIVE_SET.load(Ordering::Relaxed) as usize % SETS.len()]
}

pub fn play_start_sound() {
    if sounds_enabled() {
        let set = active();
        backend::play(set.start, set.id, "start");
    }
}

pub fn play_stop_sound() {
    if sounds_enabled() {
        let set = active();
        backend::play(set.stop, set.id, "stop");
    }
}

pub fn play_cancel_sound() {
    if sounds_enabled() {
        backend::play(CANCEL_WAV, "shared", "cancel");
    }
}

/// Play a set's start cue regardless of the on/off switch — used when the user picks
/// a set in Settings, so they hear what they chose.
pub fn preview_sound_set(id: &str) {
    if let Some(set) = SETS.iter().find(|s| s.id == id) {
        backend::play(set.start, set.id, "start");
    }
}

// ─── Platform playback backends ─────────────────────────────────────────────

#[cfg(windows)]
mod backend {
    use windows::core::PCWSTR;
    use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};

    /// `wav` is compiled into the binary ('static), so it stays valid for SND_ASYNC.
    pub fn play(wav: &'static [u8], _set: &str, _cue: &str) {
        unsafe {
            let pcwstr = PCWSTR::from_raw(wav.as_ptr() as *const u16);
            let flags = SND_MEMORY | SND_ASYNC | SND_NODEFAULT;
            let _ = PlaySoundW(pcwstr, None, flags);
        }
    }
}

#[cfg(target_os = "macos")]
mod backend {
    use objc::runtime::{Object, BOOL, NO};
    use objc::{class, msg_send, sel, sel_impl};
    use once_cell::sync::Lazy;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// A retained NSSound. Only ever touched while holding the cache lock.
    struct Sound(*mut Object);
    unsafe impl Send for Sound {}

    static CACHE: Lazy<Mutex<HashMap<String, Sound>>> = Lazy::new(|| Mutex::new(HashMap::new()));

    /// Decode once, keep the NSSound, and replay it: no process launch and no temp
    /// file per cue. Never released — there are at most nine, a few KB each.
    pub fn play(wav: &'static [u8], set: &str, cue: &str) {
        let key = format!("{set}/{cue}");
        let Ok(mut cache) = CACHE.lock() else { return };
        let sound = cache.entry(key).or_insert_with(|| unsafe {
            // alloc/init rather than the convenience constructors: this can run on a
            // thread with no autorelease pool, and nothing here is autoreleased.
            let data: *mut Object = msg_send![class!(NSData), alloc];
            let data: *mut Object =
                msg_send![data, initWithBytes: wav.as_ptr() length: wav.len()];
            let snd: *mut Object = msg_send![class!(NSSound), alloc];
            let snd: *mut Object = msg_send![snd, initWithData: data];
            let _: () = msg_send![data, release]; // NSSound keeps its own reference
            Sound(snd)
        });
        if sound.0.is_null() {
            return;
        }
        unsafe {
            // Restart from the top if the same cue is still ringing (fast toggles).
            let _: BOOL = msg_send![sound.0, stop];
            let ok: BOOL = msg_send![sound.0, play];
            if ok == NO {
                eprintln!("earcon: NSSound refused to play {set}/{cue}");
            }
        }
    }
}

#[cfg(all(not(windows), not(target_os = "macos")))]
mod backend {
    use std::path::PathBuf;

    pub fn play(wav: &'static [u8], set: &str, cue: &str) {
        let Some(path) = ensure_file(wav, &format!("{set}-{cue}")) else {
            return;
        };
        // Best-effort: PulseAudio, then ALSA.
        if std::process::Command::new("paplay").arg(&path).spawn().is_err() {
            let _ = std::process::Command::new("aplay").arg(&path).spawn();
        }
    }

    /// Write the WAV to a temp path named after the set, once; reuse it after.
    fn ensure_file(wav: &[u8], name: &str) -> Option<PathBuf> {
        let mut path = std::env::temp_dir();
        path.push(format!("localflow_{}.wav", name));
        if !path.exists() && std::fs::write(&path, wav).is_err() {
            return None;
        }
        Some(path)
    }
}
