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
    pub bars: Vec<f32>,
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
        }
    }
}

fn audio_err_fn(err: cpal::StreamError) {
    eprintln!("Audio stream error: {}", err);
}

/// Internal function usable from pipeline without Tauri State wrapper
pub fn start_capture_internal(
    state: &Arc<AudioState>,
    device_name: Option<String>,
) -> Result<(), String> {
    use cpal::SampleFormat;

    let host = cpal::default_host();

    let device = if let Some(ref name) = device_name {
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
    let supported_config = {
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

    // Mute master playback (Windows only; no-op elsewhere)
    if let Err(e) = set_master_mute(true) {
        eprintln!("Failed to mute master playback: {}", e);
    }

    if let Err(e) = stream.play() {
        let _ = set_master_mute(false);
        return Err(e.to_string());
    }

    *state.stream.lock().unwrap() = Some(stream);
    *state.is_recording.lock().unwrap() = true;

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

    if let Ok(mut amp) = state.amplitude.try_lock() {
        amp.rms = rms;
        amp.bars = bars;
    }

    let mut buffer = state.buffer.lock().unwrap();
    for sample in mono_samples {
        if buffer.len() >= max_samples {
            buffer.pop_front();
        }
        buffer.push_back(sample);
    }
}

/// Linear-resample mono f32 audio from `from_rate` to 16 kHz (Whisper's required rate).
pub fn resample_to_16k(samples: Vec<f32>, from_rate: u32) -> Vec<f32> {
    if from_rate == SAMPLE_RATE || samples.is_empty() {
        return samples;
    }
    let ratio = SAMPLE_RATE as f64 / from_rate as f64;
    let out_len = ((samples.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f64 / ratio;
        let idx = src_pos.floor() as usize;
        let frac = (src_pos - idx as f64) as f32;
        let a = samples.get(idx).copied().unwrap_or(0.0);
        let b = samples.get(idx + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
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
    *state.is_recording.lock().unwrap() = false;

    if let Err(e) = set_master_mute(false) {
        eprintln!("Failed to unmute master volume: {}", e);
    }
}
