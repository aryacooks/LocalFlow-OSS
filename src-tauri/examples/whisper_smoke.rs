// Standalone Whisper smoke test: loads a ggml model and transcribes a 16 kHz mono
// 16-bit WAV, printing the result. Proves the model + Metal + whisper-rs path works.
//   cargo run --example whisper_smoke -- <model.bin> <audio.wav>

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let model = &args[1];
    let wav = &args[2];

    let bytes = std::fs::read(wav).expect("read wav");
    let data = find(&bytes, b"data").expect("no data chunk") + 8;
    let pcm = &bytes[data..];
    let samples: Vec<f32> = pcm
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect();
    eprintln!(
        "loaded {} samples ({:.1}s @16k)",
        samples.len(),
        samples.len() as f32 / 16000.0
    );

    let ctx = WhisperContext::new_with_params(model, WhisperContextParameters::default())
        .expect("load model");
    let mut state = ctx.create_state().expect("state");
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    state.full(params, &samples).expect("run");

    let n = state.full_n_segments();
    print!("TRANSCRIPT:");
    for i in 0..n {
        if let Some(seg) = state.get_segment(i) {
            if let Ok(t) = seg.to_str() {
                print!("{}", t);
            }
        }
    }
    println!();
}
