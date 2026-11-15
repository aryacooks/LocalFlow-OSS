// Standalone Parakeet smoke test: transcribes a 16 kHz mono 16-bit WAV.
//   cargo run --release --example parakeet_smoke -- <model dir> <audio.wav>

use parakeet_rs::{ExecutionConfig, ParakeetTDT, Transcriber};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(&args[2]).expect("read wav");
    let data = bytes.windows(4).position(|w| w == b"data").expect("no data chunk") + 8;
    let samples: Vec<f32> = bytes[data..]
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect();

    let t0 = std::time::Instant::now();
    let env = parakeet_rs::ort::init().build().expect("ort env");
    let config = ExecutionConfig::new().with_environment(env);
    let mut model = ParakeetTDT::from_pretrained(&args[1], Some(config)).expect("load model");
    eprintln!("load took {:.2}s", t0.elapsed().as_secs_f32());
    let t1 = std::time::Instant::now();
    let result = model.transcribe_samples(samples, 16000, 1, None).expect("run");
    eprintln!("decode took {:.2}s", t1.elapsed().as_secs_f32());
    println!("TRANSCRIPT: {}", result.text);
}
