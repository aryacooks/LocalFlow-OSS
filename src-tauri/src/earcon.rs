/// earcon.rs — UI sound effects.
///
/// Tones are synthesized in pure Rust to WAV bytes (shared across platforms) and
/// played through the OS's native facility: PlaySoundW on Windows, `afplay` on
/// macOS. This keeps a single `cpal` version in the dependency graph (cpal is used
/// for *recording* in audio.rs) while still producing identical beeps everywhere.
use std::f32::consts::PI;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

const SAMPLE_RATE: u32 = 22050;

/// Master switch for UI beeps, toggled from Settings via `set_earcons_enabled`.
static SOUNDS_ENABLED: AtomicBool = AtomicBool::new(true);

pub fn set_sounds_enabled(enabled: bool) {
    SOUNDS_ENABLED.store(enabled, Ordering::Relaxed);
}

fn sounds_enabled() -> bool {
    SOUNDS_ENABLED.load(Ordering::Relaxed)
}

static START_WAV: OnceLock<Vec<u8>> = OnceLock::new();
static STOP_WAV: OnceLock<Vec<u8>> = OnceLock::new();
static CANCEL_WAV: OnceLock<Vec<u8>> = OnceLock::new();

/// Wrap raw mono i16 PCM samples in a minimal WAV container.
fn pcm_to_wav(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    let mut data = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        data.extend_from_slice(&s.to_le_bytes());
    }
    let data_len = data.len() as u32;
    let bits_per_sample = 16u16;
    let channels = 1u16;
    let byte_rate = sample_rate * channels as u32 * bits_per_sample as u32 / 8;
    let block_align = channels * bits_per_sample / 8;

    let mut wav = Vec::with_capacity(44 + data.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend(data);
    wav
}

/// Linear frequency sweep with fade-in / fade-out → WAV bytes.
fn generate_sweep_wav(
    start_freq: f32,
    end_freq: f32,
    duration_ms: u32,
    sample_rate: u32,
) -> Vec<u8> {
    let num_samples = (sample_rate as f32 * (duration_ms as f32 / 1000.0)) as usize;
    let mut samples = Vec::with_capacity(num_samples);
    let duration_secs = duration_ms as f32 / 1000.0;
    let fade_in = (sample_rate as f32 * 0.015) as usize;
    let fade_out = (sample_rate as f32 * 0.030) as usize;

    for i in 0..num_samples {
        let t = i as f32 / sample_rate as f32;
        let phase =
            2.0 * PI * (start_freq * t + 0.5 * (end_freq - start_freq) * t * t / duration_secs);
        let mut sample = phase.sin();
        if i < fade_in {
            sample *= i as f32 / fade_in as f32;
        } else if i > num_samples.saturating_sub(fade_out) {
            sample *= (num_samples - i) as f32 / fade_out as f32;
        }
        samples.push((sample * 14000.0) as i16);
    }
    pcm_to_wav(&samples, sample_rate)
}

/// Bell-like "ting": two mixed high frequencies with exponential decay → WAV bytes.
fn generate_ting_wav(sample_rate: u32) -> Vec<u8> {
    let duration_ms = 150;
    let num_samples = (sample_rate as f32 * (duration_ms as f32 / 1000.0)) as usize;
    let mut samples = Vec::with_capacity(num_samples);
    let (f1, f2) = (1200.0f32, 1500.0f32);

    for i in 0..num_samples {
        let t = i as f32 / sample_rate as f32;
        let decay = (-18.0 * t).exp();
        let sample = 0.6 * (2.0 * PI * f1 * t).sin() + 0.4 * (2.0 * PI * f2 * t).sin();
        samples.push((sample * decay * 14000.0) as i16);
    }
    pcm_to_wav(&samples, sample_rate)
}

pub fn play_start_sound() {
    if !sounds_enabled() {
        return;
    }
    backend::play(
        START_WAV.get_or_init(|| generate_ting_wav(SAMPLE_RATE)),
        "start",
    );
}

pub fn play_stop_sound() {
    if !sounds_enabled() {
        return;
    }
    backend::play(
        STOP_WAV.get_or_init(|| generate_sweep_wav(659.25, 523.25, 120, SAMPLE_RATE)),
        "stop",
    );
}

pub fn play_cancel_sound() {
    if !sounds_enabled() {
        return;
    }
    backend::play(
        CANCEL_WAV.get_or_init(|| generate_sweep_wav(400.0, 200.0, 150, SAMPLE_RATE)),
        "cancel",
    );
}

// ─── Platform playback backends ─────────────────────────────────────────────

#[cfg(windows)]
mod backend {
    use windows::core::PCWSTR;
    use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};

    /// `wav` points into a 'static OnceLock buffer, so it stays valid for SND_ASYNC.
    pub fn play(wav: &[u8], _name: &str) {
        unsafe {
            let pcwstr = PCWSTR::from_raw(wav.as_ptr() as *const u16);
            let flags = SND_MEMORY | SND_ASYNC | SND_NODEFAULT;
            let _ = PlaySoundW(pcwstr, None, flags);
        }
    }
}

#[cfg(not(windows))]
mod backend {
    use std::path::PathBuf;

    pub fn play(wav: &[u8], name: &str) {
        let Some(path) = ensure_file(wav, name) else {
            return;
        };
        #[cfg(target_os = "macos")]
        {
            let _ = std::process::Command::new("afplay").arg(&path).spawn();
        }
        #[cfg(not(target_os = "macos"))]
        {
            // Best-effort on other Unix (PulseAudio, then ALSA).
            if std::process::Command::new("paplay")
                .arg(&path)
                .spawn()
                .is_err()
            {
                let _ = std::process::Command::new("aplay").arg(&path).spawn();
            }
        }
    }

    /// Write the WAV to a stable temp path once; reuse it on subsequent plays.
    fn ensure_file(wav: &[u8], name: &str) -> Option<PathBuf> {
        let mut path = std::env::temp_dir();
        path.push(format!("localflow_{}.wav", name));
        if !path.exists() && std::fs::write(&path, wav).is_err() {
            return None;
        }
        Some(path)
    }
}
