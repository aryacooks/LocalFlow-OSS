//! Cloud speech-to-text through OpenRouter (`openai/whisper-large-v3-turbo`).
//!
//! This is the one place LocalFlow sends audio off the machine, and only when the user
//! has switched transcription to API mode and pasted their own OpenRouter key. The
//! request is billed to that key; OpenRouter reports the exact charge per request in
//! `usage.cost`, which is what the dashboard's running total adds up — never an estimate.
//!
//! Everything after transcription (romanization, cleanup, injection, history) is the
//! same pipeline local mode uses, so the two modes differ only in where the words come
//! from.

use base64::Engine;
use serde::Deserialize;
use std::time::Duration;

const ENDPOINT: &str = "https://openrouter.ai/api/v1/audio/transcriptions";
pub const MODEL: &str = "openai/whisper-large-v3-turbo";

/// Upstream providers time out after 60 s per request (OpenRouter's STT guide), so
/// waiting longer only delays the error. A little headroom covers the upload itself.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(75);

/// Base64 JSON past 25 MB is rejected by most providers serving this model. Plain
/// 16 kHz mono 16-bit WAV is 32 KB/s, so 25 MB of base64 is ~13 minutes of raw audio —
/// comfortably past the 10-minute recording cap. Checked anyway so a future cap change
/// fails with a clear message instead of an opaque 400.
const MAX_BASE64_BYTES: usize = 25 * 1024 * 1024;

pub struct CloudTranscript {
    pub text: String,
    /// What OpenRouter billed for this request, in USD. `None` if the response omitted
    /// usage — the total is then left untouched rather than guessed at.
    pub cost_usd: Option<f64>,
    /// Audio duration OpenRouter billed, in seconds.
    pub seconds: Option<f64>,
}

#[derive(Deserialize)]
struct TranscriptionResponse {
    text: Option<String>,
    usage: Option<Usage>,
}

#[derive(Deserialize)]
struct Usage {
    seconds: Option<f64>,
    cost: Option<f64>,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: Option<ErrorDetail>,
}

#[derive(Deserialize)]
struct ErrorDetail {
    message: Option<String>,
}

/// Encode 16 kHz mono f32 samples as a 16-bit PCM WAV file.
///
/// WAV rather than a compressed format: it is what Whisper is most accurate on (OpenRouter
/// recommends it for borderline audio), and at dictation lengths the size is no problem.
pub fn encode_wav_16k_mono(samples: &[f32]) -> Vec<u8> {
    const SAMPLE_RATE: u32 = crate::audio::SAMPLE_RATE;
    const CHANNELS: u16 = 1;
    const BITS: u16 = 16;
    let data_len = (samples.len() * 2) as u32;
    let byte_rate = SAMPLE_RATE * u32::from(CHANNELS) * u32::from(BITS) / 8;
    let block_align = CHANNELS * BITS / 8;

    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&CHANNELS.to_le_bytes());
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&BITS.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for &s in samples {
        // Clamp first: cpal can deliver samples a hair outside [-1, 1], and a plain cast
        // of an out-of-range float would wrap into a loud click.
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// Turn an OpenRouter failure into something a person can act on.
fn friendly_error(status: reqwest::StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<ErrorBody>(body)
        .ok()
        .and_then(|b| b.error)
        .and_then(|e| e.message)
        .unwrap_or_else(|| body.chars().take(200).collect());
    match status.as_u16() {
        401 => "OpenRouter rejected the API key. Check it in Settings → Transcription.".into(),
        402 => "Your OpenRouter account is out of credits. Top up at openrouter.ai, or switch back to Local.".into(),
        429 => "OpenRouter is rate-limiting requests. Wait a moment and try again.".into(),
        408 | 504 => "OpenRouter timed out transcribing this recording. Try a shorter one, or switch to Local.".into(),
        _ => format!("OpenRouter error ({}): {}", status.as_u16(), detail),
    }
}

/// Transcribe 16 kHz mono audio with OpenRouter.
///
/// `language` is an ISO-639-1 code to force, or `None` to let the model detect it.
pub async fn transcribe(
    api_key: &str,
    samples_16k: &[f32],
    language: Option<&str>,
) -> Result<CloudTranscript, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(
            "API mode is on but no OpenRouter key is saved. Add one in Settings → Transcription."
                .into(),
        );
    }

    let wav = encode_wav_16k_mono(samples_16k);
    let audio_b64 = base64::engine::general_purpose::STANDARD.encode(&wav);
    if audio_b64.len() > MAX_BASE64_BYTES {
        return Err("This recording is too long to send to OpenRouter in one request. Switch to Local for very long takes.".into());
    }

    let mut body = serde_json::json!({
        "model": MODEL,
        "input_audio": { "data": audio_b64, "format": "wav" },
        // Same stance as the local decoder: greedy first, so the same audio gives the
        // same words.
        "temperature": 0,
    });
    if let Some(lang) = language {
        body["language"] = serde_json::Value::String(lang.to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Could not start the network client: {}", e))?;

    let resp = client
        .post(ENDPOINT)
        .bearer_auth(api_key)
        // Optional attribution headers OpenRouter uses for its app rankings.
        .header("HTTP-Referer", "https://github.com/aryacooks/LocalFlow-OSS")
        .header("X-Title", "LocalFlow")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::to_vec(&body).map_err(|e| e.to_string())?)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "OpenRouter took too long to respond. Check your connection, or switch to Local.".to_string()
            } else if e.is_connect() {
                "Couldn't reach OpenRouter — are you offline? Switch to Local to keep dictating.".to_string()
            } else {
                format!("Network error talking to OpenRouter: {}", e)
            }
        })?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Could not read OpenRouter's response: {}", e))?;
    if !status.is_success() {
        return Err(friendly_error(status, &text));
    }

    let parsed: TranscriptionResponse = serde_json::from_str(&text)
        .map_err(|e| format!("Unexpected response from OpenRouter: {}", e))?;

    Ok(CloudTranscript {
        text: parsed.text.unwrap_or_default().trim().to_string(),
        cost_usd: parsed.usage.as_ref().and_then(|u| u.cost),
        seconds: parsed.usage.as_ref().and_then(|u| u.seconds),
    })
}

/// Show enough of a key to recognise it, never enough to use it.
pub fn mask_key(key: &str) -> String {
    let key = key.trim();
    let n = key.chars().count();
    if n <= 10 {
        return "•".repeat(n.max(4));
    }
    let head: String = key.chars().take(6).collect();
    let tail: String = key.chars().skip(n - 4).collect();
    format!("{head}…{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_is_valid_16k_mono_pcm() {
        let wav = encode_wav_16k_mono(&[0.0, 0.5, -0.5, 1.0]);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 8); // 4 samples × 2 B
        assert_eq!(wav.len(), 44 + 8);
    }

    #[test]
    fn out_of_range_samples_clamp_instead_of_wrapping() {
        let wav = encode_wav_16k_mono(&[2.0, -2.0]);
        let hi = i16::from_le_bytes(wav[44..46].try_into().unwrap());
        let lo = i16::from_le_bytes(wav[46..48].try_into().unwrap());
        assert_eq!(hi, i16::MAX);
        assert_eq!(lo, -i16::MAX);
    }

    #[test]
    fn masked_key_never_reveals_the_middle() {
        let m = mask_key("sk-or-v1-0123456789abcdefSECRETabcd");
        assert!(m.starts_with("sk-or-"));
        assert!(m.ends_with("abcd"));
        assert!(!m.contains("SECRET"));
        assert_eq!(mask_key("short"), "•••••");
    }

    #[test]
    fn errors_are_actionable() {
        let s = |c| reqwest::StatusCode::from_u16(c).unwrap();
        assert!(friendly_error(s(401), "").contains("API key"));
        assert!(friendly_error(s(402), "").contains("credits"));
        assert!(friendly_error(s(400), r#"{"error":{"message":"bad audio"}}"#).contains("bad audio"));
    }
}
