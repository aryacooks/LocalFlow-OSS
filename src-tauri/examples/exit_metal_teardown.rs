// Regression repro for the quit-time crash: "LocalFlow quit unexpectedly" (SIGABRT) on
// every Quit once a model had been used.
//
// ggml destroys its global Metal device from a C++ static destructor during `exit()`.
// A WhisperContext still alive at that moment is still holding Metal resource sets, so
// `ggml_metal_rsets_free` trips `GGML_ASSERT([rsets->data count] == 0)` and aborts. The
// app's cache is a Rust `static`, whose Drop never runs — so nothing released it, and
// the assert fired on every quit. `lib.rs` now drops the cache on `RunEvent::Exit`.
//
// Needs a model, like `whisper_smoke`:
//   export LOCALFLOW_TEST_MODEL=~/Library/Application\ Support/com.localflow.desktop/models/<model>.bin
//   cargo run --release --example exit_metal_teardown        # reproduces: aborts, exit 134
//   cargo run --release --example exit_metal_teardown drop   # the fix: exits 0
use once_cell::sync::Lazy;
use std::sync::{Arc, Mutex};
use whisper_rs::{WhisperContext, WhisperContextParameters};

static CACHE: Lazy<Mutex<Option<Arc<WhisperContext>>>> = Lazy::new(|| Mutex::new(None));

fn main() {
    let model = std::env::var("LOCALFLOW_TEST_MODEL").expect("LOCALFLOW_TEST_MODEL");
    let ctx = WhisperContext::new_with_params(&model, WhisperContextParameters::default())
        .expect("load");
    *CACHE.lock().unwrap() = Some(Arc::new(ctx));
    eprintln!("model loaded and cached");

    if std::env::args().any(|a| a == "drop") {
        *CACHE.lock().unwrap() = None;
        eprintln!("cache released before exit");
    }

    // What -[NSApplication terminate:] ends up doing: exit() runs static destructors.
    std::process::exit(0);
}
