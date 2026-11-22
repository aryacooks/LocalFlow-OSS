use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tauri::State;

// Longest single recording we keep. Past this the buffer rolls, dropping the oldest
// audio, so the cap trades memory against how much of a very long take survives.
//
// Cost is linear and paid only while recording: the buffer holds f32 mono samples at the
// device's capture rate, so 10 min at 48 kHz is 600 * 48000 * 4 B ≈ 115 MB of address
// space. Physical pages are only committed as audio actually arrives, so a 5-second
// dictation still costs ~1 MB — the reservation itself is close to free.
//
// Two caveats worth knowing before raising this further: transcription time scales with
// length (a 10-minute take is a long wait with no partial output), and Whisper's decoder
// is more likely to lock into a repetition loop the longer the audio runs — see
// `whisper::collapse_repetitions`.
//
// The Dashboard states this limit to the user (src/routes/Dashboard.tsx, "Recording
// limits" under Diagnostics) — change both together.
const MAX_RECORDING_SECS: usize = 600;

// Pre-allocation hint used before the device's real capture rate is known (16 kHz * 30 s).
// `start_audio_capture` reserves the full per-device cap up front, so the audio callback
// never has to reallocate.
pub const SAMPLE_RATE: u32 = 16000;
const BUFFER_CAPACITY: usize = 480_000;

#[derive(Default, Serialize, Clone)]
pub struct AudioAmplitude {
    pub rms: f32,
    /// 8 time slices of the last callback, auto-gained (always looks busy).
    pub bars: Vec<f32>,
    /// Loudness 0..1 on a dB scale: ~0 in a quiet room, ~1 for loud speech.
    pub level: f32,
    /// 8 voice-frequency bands (low → high, ~120 Hz–4 kHz), 0..1 on a dB scale.
    /// Unlike `bars`, these stay low when you're quiet, so a wave built on them
    /// actually follows the voice.
    pub bands: Vec<f32>,
}

/// Map a linear amplitude to 0..1 between `floor_db` and `ceil_db`.
fn db_unit(amp: f32, floor_db: f32, ceil_db: f32) -> f32 {
    let db = 20.0 * amp.max(1e-7).log10();
    ((db - floor_db) / (ceil_db - floor_db)).clamp(0.0, 1.0)
}

/// Energy in 8 log-spaced bands from 120 Hz to 4 kHz, via a few Goertzel probes per
/// band on a Hann-windowed block (cheap enough for the audio callback; no FFT crate).
fn voice_bands(samples: &[f32], rate: f32) -> Vec<f32> {
    const LO: f32 = 120.0;
    const HI: f32 = 4000.0;
    const PROBES: usize = 3;
    let n = samples.len();
    if n < 32 || rate <= 0.0 {
        return vec![0.0; 8];
    }
    let windowed: Vec<f32> = samples
        .iter()
        .enumerate()
        .map(|(i, &x)| {
            let w = 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (n - 1) as f32).cos();
            x * w
        })
        .collect();
    let ratio = (HI / LO).powf(1.0 / 8.0);
    (0..8)
        .map(|b| {
            let f0 = LO * ratio.powi(b as i32);
            let mut best = 0.0f32;
            for p in 0..PROBES {
                let f = f0 * ratio.powf((p as f32 + 0.5) / PROBES as f32);
                if f >= rate / 2.0 {
                    break;
                }
                let coeff = 2.0 * (std::f32::consts::TAU * f / rate).cos();
                let (mut s1, mut s2) = (0.0f32, 0.0f32);
                for &x in &windowed {
                    let s0 = x + coeff * s1 - s2;
                    s2 = s1;
                    s1 = s0;
                }
                let power = (s1 * s1 + s2 * s2 - coeff * s1 * s2).max(0.0);
                // ≈ sine amplitude at f (Hann gain is 0.5).
                best = best.max(power.sqrt() * 4.0 / n as f32);
            }
            // Voice energy falls off with frequency; tilt so highs still move.
            let tilt = 10f32.powf(2.5 * b as f32 / 20.0);
            db_unit(best * tilt, -62.0, -24.0)
        })
        .collect()
}

pub struct AudioState {
    pub buffer: Mutex<VecDeque<f32>>,
    pub stream: Mutex<Option<cpal::Stream>>,
    pub is_recording: Mutex<bool>,
    pub amplitude: Mutex<AudioAmplitude>,
    pub device_name: Mutex<String>,
    /// The actual capture sample rate (device-dependent). Buffer audio is stored at
    /// this rate and resampled to 16 kHz before transcription.
    pub sample_rate: Mutex<u32>,
    /// "mic" (default) or "system": what Settings → Audio input listens to.
    pub source: Mutex<String>,
    /// The system-audio capture while it runs (macOS).
    #[cfg(target_os = "macos")]
    pub tap: Mutex<Option<crate::systap::SystemTap>>,
    /// The mic check in Settings is running (levels only, not a dictation).
    pub testing: Mutex<bool>,
}

impl AudioState {
    pub fn new() -> Self {
        Self {
            buffer: Mutex::new(VecDeque::with_capacity(BUFFER_CAPACITY)),
            stream: Mutex::new(None),
            is_recording: Mutex::new(false),
            amplitude: Mutex::new(AudioAmplitude::default()),
            device_name: Mutex::new(String::new()),
            sample_rate: Mutex::new(SAMPLE_RATE),
            source: Mutex::new("mic".into()),
            #[cfg(target_os = "macos")]
            tap: Mutex::new(None),
            testing: Mutex::new(false),
        }
    }
}

fn audio_err_fn(err: cpal::StreamError) {
    eprintln!("Audio stream error: {}", err);
}

/// Internal function usable from pipeline without Tauri State wrapper
/// True while the mic is open; the model reapers leave the model alone then.
pub static RECORDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn start_capture_internal(
    state: &Arc<AudioState>,
    device_name: Option<String>,
) -> Result<(), String> {
    start_capture(state, device_name, false)
}

fn listening_to_system(state: &AudioState) -> bool {
    state.source.lock().map(|s| s.as_str() == "system").unwrap_or(false)
}

/// Start listening. `test` = the mic check in Settings: levels only, no dictation side
/// effects (music isn't paused, the model isn't loaded, nothing counts as recording).
pub fn start_capture(
    state: &Arc<AudioState>,
    device_name: Option<String>,
    test: bool,
) -> Result<(), String> {
    use cpal::SampleFormat;

    // Anything already open (e.g. the mic check) is replaced.
    *state.stream.lock().unwrap() = None;
    #[cfg(target_os = "macos")]
    {
        *state.tap.lock().unwrap() = None;
    }
    *state.testing.lock().unwrap() = test;

    let system = listening_to_system(state);

    // macOS: what the Mac is playing, through a Core Audio tap.
    #[cfg(target_os = "macos")]
    if system {
        let max_samples = 48_000 * MAX_RECORDING_SECS;
        {
            let mut buffer = state.buffer.lock().unwrap();
            buffer.clear();
            buffer.shrink_to_fit();
            buffer.reserve_exact(max_samples);
        }
        let st = state.clone();
        let (tap, rate) = crate::systap::SystemTap::start(Box::new(move |mono: &[f32]| {
            process_input(mono, 1, &st, max_samples)
        }))?;
        *state.sample_rate.lock().unwrap() = rate;
        *state.tap.lock().unwrap() = Some(tap);
        return finish_start(state, test, system);
    }

    let host = cpal::default_host();

    // Windows: system audio is a "loopback" recording of the speakers.
    #[cfg(windows)]
    let loopback = system;
    #[cfg(not(windows))]
    let loopback = false;

    let device = if loopback {
        host.default_output_device().ok_or("No speakers or headphones found to listen to.")?
    } else if let Some(ref name) = device_name {
        match host
            .input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().map(|n| n == *name).unwrap_or(false))
        {
            Some(device) => device,
            None => {
                eprintln!(
                    "Saved microphone '{}' is unavailable; using the system default.",
                    name
                );
                host.default_input_device()
                    .ok_or("No microphone detected. Connect or enable one in System Settings.")?
            }
        }
    } else {
        host.default_input_device()
            .ok_or("No microphone detected. Connect or enable one in System Settings.")?
    };

    if let Ok(name) = device.name() {
        *state.device_name.lock().unwrap() = name;
    }

    // Prefer a config that natively supports 16 kHz (no resampling needed);
    // otherwise fall back to the device's default config and resample later.
    // Most macOS mics only support 44.1/48 kHz, so the fallback is the norm there.
    let supported_config = if loopback {
        device
            .default_output_config()
            .map_err(|e| format!("Can't listen to system audio: {}", e))?
    } else {
        let direct = device
            .supported_input_configs()
            .ok()
            .and_then(|mut configs| {
                configs.find(|c| {
                    c.min_sample_rate() <= SAMPLE_RATE && c.max_sample_rate() >= SAMPLE_RATE
                })
            });
        match direct {
            Some(range) => range.with_sample_rate(SAMPLE_RATE),
            None => device
                .default_input_config()
                .map_err(|e| format!("No usable input config: {}", e))?,
        }
    };

    let channels = supported_config.channels() as usize;
    let sample_format = supported_config.sample_format();
    let actual_rate = supported_config.sample_rate();
    let config: cpal::StreamConfig = supported_config.into();

    // Remember the capture rate so the pipeline can resample to 16 kHz for Whisper.
    *state.sample_rate.lock().unwrap() = actual_rate;

    let max_samples = (actual_rate as usize) * MAX_RECORDING_SECS;

    // Start empty, and reserve the whole cap now. `process_input` runs on the realtime
    // audio thread, where a mid-recording reallocation would mean copying tens of MB and
    // risking a dropout — reserving here moves that cost off the audio thread entirely.
    {
        let mut buffer = state.buffer.lock().unwrap();
        buffer.clear();
        buffer.shrink_to_fit();
        buffer.reserve_exact(max_samples);
    }

    // Build the stream for the device's native sample format, converting to f32.
    let stream = match sample_format {
        SampleFormat::F32 => {
            let st = state.clone();
            device.build_input_stream(
                &config,
                move |data: &[f32], _: &_| process_input(data, channels, &st, max_samples),
                audio_err_fn,
                None,
            )
        }
        SampleFormat::I16 => {
            let st = state.clone();
            device.build_input_stream(
                &config,
                move |data: &[i16], _: &_| {
                    let floats: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                    process_input(&floats, channels, &st, max_samples);
                },
                audio_err_fn,
                None,
            )
        }
        SampleFormat::U16 => {
            let st = state.clone();
            device.build_input_stream(
                &config,
                move |data: &[u16], _: &_| {
                    let floats: Vec<f32> = data
                        .iter()
                        .map(|&s| (s as f32 - 32768.0) / 32768.0)
                        .collect();
                    process_input(&floats, channels, &st, max_samples);
                },
                audio_err_fn,
                None,
            )
        }
        other => return Err(format!("Unsupported input sample format: {:?}", other)),
    }
    .map_err(|e| e.to_string())?;

    if let Err(e) = stream.play() {
        return Err(e.to_string());
    }

    *state.stream.lock().unwrap() = Some(stream);
    finish_start(state, test, system)
}

fn finish_start(state: &Arc<AudioState>, test: bool, system: bool) -> Result<(), String> {
    if test {
        return Ok(());
    }
    *state.is_recording.lock().unwrap() = true;
    RECORDING.store(true, std::sync::atomic::Ordering::SeqCst);
    // No time limit: older audio is transcribed in pieces while you keep talking.
    crate::longrec::start(state.clone());
    // Load the speech model while you talk, so it's ready when you stop.
    crate::preload_speech_model();
    // Pause / turn down music while you talk (Settings → Pause music while dictating).
    // Never when transcribing system audio: that's the sound we want.
    if !system {
        crate::media::begin();
    }

    Ok(())
}

/// Downmix interleaved samples to mono, update amplitude bars, and append to buffer.
fn process_input(data: &[f32], channels: usize, state: &Arc<AudioState>, max_samples: usize) {
    let channels = channels.max(1);
    let mono_samples: Vec<f32> = data
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect();

    // Compute amplitude bars (8 bars) with dynamic scaling/normalization
    let chunk_size = (mono_samples.len() / 8).max(1);
    let mut chunk_rmss = Vec::new();
    for chunk in mono_samples.chunks(chunk_size).take(8) {
        let rms = (chunk.iter().map(|s| s * s).sum::<f32>() / chunk.len() as f32).sqrt();
        chunk_rmss.push(rms);
    }

    let max_rms = chunk_rmss.iter().cloned().fold(0.0f32, f32::max);

    // Auto-gain scaling: normalizes quiet vs loud environments
    let scale = if max_rms < 0.002 { 15.0 } else { 0.8 / max_rms };

    let mut bars: Vec<f32> = chunk_rmss
        .iter()
        .map(|&rms| (rms * scale).clamp(0.08, 1.0))
        .collect();
    while bars.len() < 8 {
        bars.push(0.05);
    }

    let rms =
        (mono_samples.iter().map(|s| s * s).sum::<f32>() / mono_samples.len().max(1) as f32).sqrt();

    let rate = state.sample_rate.try_lock().map(|r| *r).unwrap_or(SAMPLE_RATE) as f32;
    let bands = voice_bands(&mono_samples, rate);
    let level = db_unit(rms, -55.0, -16.0);

    if let Ok(mut amp) = state.amplitude.try_lock() {
        amp.rms = rms;
        amp.bars = bars;
        amp.level = level;
        amp.bands = bands;
    }

    let mut buffer = state.buffer.lock().unwrap();
    for sample in mono_samples {
        if buffer.len() >= max_samples {
            buffer.pop_front();
        }
        buffer.push_back(sample);
    }
}

/// Resample mono f32 audio from `from_rate` to 16 kHz (Whisper's required rate).
///
/// Going down from 44.1/48 kHz, everything above 8 kHz has to be filtered out first.
/// Skipping that (plain linear interpolation) folds the hiss of "s", "f", "t" and "th"
/// back down on top of the speech band, and Whisper then mishears or drops words.
/// So: a windowed-sinc low-pass, evaluated only at the two input samples each output
/// sample sits between, then linear interpolation between those.
pub fn resample_to_16k(samples: Vec<f32>, from_rate: u32) -> Vec<f32> {
    if from_rate == SAMPLE_RATE || samples.is_empty() {
        return samples;
    }
    let ratio = SAMPLE_RATE as f64 / from_rate as f64;
    let out_len = ((samples.len() as f64) * ratio).round() as usize;

    // Upsampling (rare: an 8 kHz headset) has nothing to filter out.
    let taps: Vec<f32> = if from_rate > SAMPLE_RATE {
        // Cutoff a little under the new Nyquist (8 kHz), as a fraction of the input rate.
        let fc = 0.46 * SAMPLE_RATE as f64 / from_rate as f64;
        // 8 output periods either side.
        let half = (8.0 * from_rate as f64 / SAMPLE_RATE as f64).ceil() as isize;
        let mut t: Vec<f32> = (-half..=half)
            .map(|k| {
                let x = k as f64;
                let sinc = if k == 0 { 2.0 * fc } else { (2.0 * std::f64::consts::PI * fc * x).sin() / (std::f64::consts::PI * x) };
                // Blackman window
                let w = 0.42 + 0.5 * (std::f64::consts::PI * x / half as f64).cos()
                    + 0.08 * (2.0 * std::f64::consts::PI * x / half as f64).cos();
                (sinc * w) as f32
            })
            .collect();
        let sum: f32 = t.iter().sum();
        t.iter_mut().for_each(|v| *v /= sum);
        t
    } else {
        vec![1.0]
    };
    let half = (taps.len() / 2) as isize;
    let n = samples.len() as isize;
    let filtered_at = |center: isize| -> f32 {
        let mut acc = 0.0f32;
        for (j, &tap) in taps.iter().enumerate() {
            let idx = (center + j as isize - half).clamp(0, n - 1);
            acc += samples[idx as usize] * tap;
        }
        acc
    };

    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f64 / ratio;
        let idx = src_pos.floor() as isize;
        let frac = (src_pos - idx as f64) as f32;
        let a = filtered_at(idx);
        let b = if frac > 0.0 { filtered_at(idx + 1) } else { a };
        out.push(a + (b - a) * frac);
    }
    out
}

/// How long recording keeps going after the user lets go. People release the key as
/// they finish the last word, and without this its ending is cut off.
pub const TAIL_MS: u64 = 220;

#[cfg(test)]
mod resample_tests {
    use super::resample_to_16k;

    fn tone(freq: f32, rate: u32) -> Vec<f32> {
        (0..rate).map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin()).collect()
    }
    fn rms(x: &[f32]) -> f32 {
        let mid = &x[x.len() / 4..3 * x.len() / 4];
        (mid.iter().map(|v| v * v).sum::<f32>() / mid.len() as f32).sqrt()
    }

    #[test]
    fn keeps_speech_and_removes_what_would_alias() {
        for rate in [48_000, 44_100] {
            let speech = resample_to_16k(tone(1_000.0, rate), rate);
            assert_eq!(speech.len(), 16_000);
            assert!((rms(&speech) - 0.707).abs() < 0.03, "1 kHz at {rate}: {}", rms(&speech));
            assert!(rms(&resample_to_16k(tone(6_000.0, rate), rate)) > 0.6);
            // 10 kHz can't exist at 16 kHz; unfiltered it would reappear as a 6 kHz tone.
            let alias = rms(&resample_to_16k(tone(10_000.0, rate), rate));
            assert!(alias < 0.02, "10 kHz leaked through at {rate}: {alias}");
        }
    }
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_audio_devices() -> Vec<String> {
    let host = cpal::default_host();
    match host.input_devices() {
        Ok(devices) => devices.filter_map(|d| d.name().ok()).collect(),
        Err(_) => vec![],
    }
}

#[tauri::command]
pub fn set_audio_device(state: State<'_, Arc<AudioState>>, device_name: String) {
    *state.device_name.lock().unwrap() = device_name;
}

/// Settings → Audio input → Listen to: "mic" or "system".
#[tauri::command]
pub fn set_audio_source(state: State<'_, Arc<AudioState>>, source: String) {
    *state.source.lock().unwrap() = if source == "system" { "system".into() } else { "mic".into() };
}

/// Whether "System audio" can be offered here.
#[tauri::command]
pub fn system_audio_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        crate::systap::supported()
    }
    #[cfg(windows)]
    {
        true
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        false
    }
}

/// Settings → Check audio levels: listen without dictating; read levels with get_amplitude.
#[tauri::command]
pub fn start_level_meter(state: State<'_, Arc<AudioState>>) -> Result<(), String> {
    if *state.is_recording.lock().unwrap() {
        return Ok(()); // a dictation is running; its levels are already live
    }
    let device = state.device_name.lock().unwrap().clone();
    let dev = (!device.is_empty()).then_some(device);
    *state.amplitude.lock().unwrap() = AudioAmplitude::default();
    start_capture(state.inner(), dev, true)
}

#[tauri::command]
pub fn stop_level_meter(state: State<'_, Arc<AudioState>>) {
    // Only the check's own capture: never cut off a dictation started meanwhile.
    if *state.testing.lock().unwrap() && !*state.is_recording.lock().unwrap() {
        stop_capture_internal(state.inner());
        state.buffer.lock().unwrap().clear();
    }
}

#[tauri::command]
pub fn start_audio_capture(
    state: State<'_, Arc<AudioState>>,
    device_name: Option<String>,
) -> Result<(), String> {
    let is_rec = *state.is_recording.lock().unwrap();
    if is_rec {
        return Err("Already recording".into());
    }
    start_capture_internal(state.inner(), device_name)
}

#[tauri::command]
pub fn stop_audio_capture(state: State<'_, Arc<AudioState>>) -> Result<usize, String> {
    if !*state.is_recording.lock().unwrap() {
        return Err("Not recording".into());
    }
    stop_capture_internal(state.inner());
    Ok(state.buffer.lock().unwrap().len())
}

#[tauri::command]
pub fn get_amplitude(state: State<'_, Arc<AudioState>>) -> AudioAmplitude {
    state.amplitude.lock().unwrap().clone()
}

#[tauri::command]
pub fn is_recording(state: State<'_, Arc<AudioState>>) -> bool {
    *state.is_recording.lock().unwrap()
}

#[cfg(windows)]
pub fn set_master_mute(mute: bool) -> Result<(), String> {
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
        COINIT_DISABLE_OLE1DDE,
    };

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);

        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("CoCreateInstance IMMDeviceEnumerator failed: {}", e))?;

        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| format!("GetDefaultAudioEndpoint failed: {}", e))?;

        let endpoint_volume: IAudioEndpointVolume = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("Activate IAudioEndpointVolume failed: {}", e))?;

        endpoint_volume
            .SetMute(mute, std::ptr::null())
            .map_err(|e| format!("SetMute failed: {}", e))?;
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn set_master_mute(_mute: bool) -> Result<(), String> {
    Ok(())
}

pub fn stop_capture_internal(state: &AudioState) {
    *state.stream.lock().unwrap() = None;
    #[cfg(target_os = "macos")]
    {
        *state.tap.lock().unwrap() = None;
    }
    *state.testing.lock().unwrap() = false;
    *state.is_recording.lock().unwrap() = false;
    RECORDING.store(false, std::sync::atomic::Ordering::SeqCst);
    crate::whisper::touch();
    crate::media::end();
}
