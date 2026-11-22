/// longrec.rs — recordings with no time limit.
///
/// The mic buffer only holds about 10 minutes. So while you keep talking, every
/// `CHUNK_SECS` the oldest part of the buffer is cut off (at the quietest moment near
/// the cut, never mid-word), transcribed in the background, and its text kept. When you
/// stop, the pipeline transcribes what's left and puts it after the earlier pieces, so
/// the whole thing is cleaned up and pasted once, as one dictation.
///
/// Pieces are transcribed one at a time, in order, on a single worker thread. A new
/// recording (or a cancel) bumps the generation, so text from an old one never leaks in.
use crate::audio::AudioState;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// How much audio goes into each background piece.
const CHUNK_SECS: usize = 8 * 60;
/// Look this far back from the cut point for a pause to cut at.
const SEARCH_SECS: usize = 8;

#[derive(Default)]
struct Inner {
    gen: u64,
    texts: Vec<String>,
    pending: usize,
    /// Seconds of audio already handed to the worker (for the History duration).
    secs: f64,
}

static STATE: Mutex<Inner> = Mutex::new(Inner { gen: 0, texts: Vec::new(), pending: 0, secs: 0.0 });
static DONE: Condvar = Condvar::new();

/// A recording started: forget any earlier pieces and watch this one.
pub fn start(audio: Arc<AudioState>) {
    let gen = {
        let mut s = STATE.lock().unwrap_or_else(|e| e.into_inner());
        s.gen += 1;
        s.texts.clear();
        s.pending = 0;
        s.secs = 0.0;
        s.gen
    };
    std::thread::Builder::new()
        .name("long-recording".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(2));
            if STATE.lock().map(|s| s.gen != gen).unwrap_or(true)
                || !crate::audio::RECORDING.load(std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
            let rate = *audio.sample_rate.lock().unwrap() as usize;
            let Some(piece) = take_piece(&audio, rate) else { continue };
            {
                let mut s = STATE.lock().unwrap_or_else(|e| e.into_inner());
                if s.gen != gen {
                    return;
                }
                s.pending += 1;
                s.secs += piece.len() as f64 / rate as f64;
            }
            transcribe_piece(gen, piece, rate as u32);
        })
        .ok();
}

/// Cut the first ~CHUNK_SECS off the buffer, at the quietest 100 ms near the cut.
fn take_piece(audio: &AudioState, rate: usize) -> Option<Vec<f32>> {
    let mut buf = audio.buffer.lock().unwrap();
    let target = CHUNK_SECS * rate;
    if buf.len() < target + rate {
        return None;
    }
    let window = rate / 10;
    let lo = target.saturating_sub(SEARCH_SECS * rate);
    let energy = |i: usize| -> f32 { (i..(i + window).min(buf.len())).map(|j| buf[j] * buf[j]).sum() };
    let cut = (lo..target)
        .step_by(window / 2)
        .min_by(|&a, &b| energy(a).total_cmp(&energy(b)))
        .map_or(target, |i| i + window / 2);
    Some(buf.drain(..cut).collect())
}

/// Transcribe one piece on the worker thread (in order) and keep its text.
fn transcribe_piece(gen: u64, samples: Vec<f32>, rate: u32) {
    use std::sync::mpsc::{channel, Sender};
    type Job = (u64, Vec<f32>, u32);
    static WORKER: Mutex<Option<Sender<Job>>> = Mutex::new(None);

    let mut w = WORKER.lock().unwrap_or_else(|e| e.into_inner());
    if w.is_none() {
        let (tx, rx) = channel::<Job>();
        std::thread::Builder::new()
            .name("long-recording-transcribe".into())
            .spawn(move || {
                for (gen, samples, rate) in rx {
                    let audio16 = crate::audio::resample_to_16k(samples, rate);
                    let text = crate::transcribe_piece(&audio16).unwrap_or_else(|e| {
                        eprintln!("long recording: a piece failed: {e}");
                        String::new()
                    });
                    let mut s = STATE.lock().unwrap_or_else(|e| e.into_inner());
                    if s.gen == gen {
                        if !text.trim().is_empty() {
                            s.texts.push(text.trim().to_string());
                        }
                        s.pending = s.pending.saturating_sub(1);
                        DONE.notify_all();
                    }
                }
            })
            .ok();
        *w = Some(tx);
    }
    if let Some(tx) = w.as_ref() {
        let _ = tx.send((gen, samples, rate));
    }
}

/// The recording stopped: wait for pieces still being transcribed, then hand back
/// their text (in order) and how many seconds they covered.
pub fn finish() -> (Vec<String>, f64) {
    // The watcher already stops on its own: the mic is closed (RECORDING is false).
    let mut s = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let deadline = std::time::Instant::now() + Duration::from_secs(600);
    while s.pending > 0 && std::time::Instant::now() < deadline {
        s = DONE
            .wait_timeout(s, Duration::from_millis(250))
            .unwrap_or_else(|e| e.into_inner())
            .0;
    }
    s.gen += 1; // anything still running now belongs to nobody
    s.pending = 0;
    let texts = std::mem::take(&mut s.texts);
    let secs = std::mem::replace(&mut s.secs, 0.0);
    (texts, secs)
}

/// Esc / cancelled: drop everything.
pub fn cancel() {
    let mut s = STATE.lock().unwrap_or_else(|e| e.into_inner());
    s.gen += 1;
    s.texts.clear();
    s.pending = 0;
    s.secs = 0.0;
    DONE.notify_all();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn piece_is_cut_at_the_pause_and_the_rest_stays() {
        let rate = 1000;
        let audio = AudioState::new();
        let total = CHUNK_SECS * rate + 5 * rate;
        let pause = CHUNK_SECS * rate - 3 * rate; // quiet 3 s before the target cut
        {
            let mut buf = audio.buffer.lock().unwrap();
            for i in 0..total {
                let quiet = i >= pause && i < pause + rate / 2;
                buf.push_back(if quiet { 0.0 } else { 0.5 });
            }
        }
        let piece = take_piece(&audio, rate).expect("long enough to cut");
        assert!((piece.len() as i64 - pause as i64).abs() < rate as i64 / 2, "cut at {}", piece.len());
        assert_eq!(piece.len() + audio.buffer.lock().unwrap().len(), total);
    }

    #[test]
    fn short_recordings_are_left_alone() {
        let rate = 1000;
        let audio = AudioState::new();
        audio.buffer.lock().unwrap().extend(std::iter::repeat(0.5).take(60 * rate));
        assert!(take_piece(&audio, rate).is_none());
    }
}
