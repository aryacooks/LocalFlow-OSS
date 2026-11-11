/// tint.rs — adaptive orb colour.
///
/// Like Vehicle Motion Cues, the on-screen orb flips between black and white to stay
/// visible against whatever is behind it. A few times a second we grab the small patch
/// of screen *under* the bubble window (our own window excluded), average its luminance
/// and tell the bubble webview `light` or `dark` through the `bubble-tint` event.
///
/// On macOS, reading other apps' pixels needs Screen Recording permission. Without it
/// the capture only contains the wallpaper, so the colour still follows the desktop.
/// Only a ~60 pt patch is read, nothing is stored, and the loop idles unless the
/// on-screen orb is showing (not in notch mode or with the animation off).
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use tauri::{Emitter, Manager};

static ENABLED: AtomicBool = AtomicBool::new(false);
/// CGWindowID of the bubble window, so the capture can exclude it.
static WINDOW_ID: AtomicU32 = AtomicU32::new(0);

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

pub fn set_window_id(id: u32) {
    WINDOW_ID.store(id, Ordering::Relaxed);
}

/// Ask for Screen Recording once (macOS shows its own prompt; it is a no-op when
/// already granted or denied). Returns whether access is granted right now.
pub fn request_access() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGPreflightScreenCaptureAccess() -> bool;
            fn CGRequestScreenCaptureAccess() -> bool;
        }
        if CGPreflightScreenCaptureAccess() {
            return true;
        }
        return CGRequestScreenCaptureAccess();
    }
    #[allow(unreachable_code)]
    false
}

/// Start the sampling loop (once, at startup). It sleeps while disabled.
pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last: Option<bool> = None; // Some(true) = light background
        loop {
            std::thread::sleep(std::time::Duration::from_millis(350));
            if !ENABLED.load(Ordering::Relaxed) {
                last = None;
                continue;
            }
            let Some(b) = app.get_webview_window("bubble") else { continue };
            if !b.is_visible().unwrap_or(false) {
                continue;
            }
            let Some(lum) = sample(&b) else { continue };
            // Hysteresis so mid-grey backgrounds don't make it flicker.
            let light = match last {
                Some(true) => lum > 0.42,
                Some(false) => lum > 0.58,
                None => lum > 0.5,
            };
            if last != Some(light) {
                last = Some(light);
                let _ = app.emit("bubble-tint", if light { "light" } else { "dark" });
            }
        }
    });
}

/// Average luminance (0..1) of the screen directly behind the bubble window.
#[cfg(target_os = "macos")]
fn sample(b: &tauri::WebviewWindow) -> Option<f32> {
    use core_graphics::geometry::{CGPoint, CGRect, CGSize};
    use core_graphics::window::{
        create_image, kCGWindowImageNominalResolution, kCGWindowListOptionOnScreenBelowWindow,
    };

    let id = WINDOW_ID.load(Ordering::Relaxed);
    if id == 0 {
        return None;
    }
    let sf = b.scale_factor().ok()?;
    let pos = b.outer_position().ok()?;
    let size = b.outer_size().ok()?;
    // Global display points, top-left origin — the same space CoreGraphics uses.
    let rect = CGRect::new(
        &CGPoint::new(pos.x as f64 / sf, pos.y as f64 / sf),
        &CGSize::new(size.width as f64 / sf, size.height as f64 / sf),
    );
    let img = create_image(
        rect,
        kCGWindowListOptionOnScreenBelowWindow,
        id,
        kCGWindowImageNominalResolution,
    )?;
    if img.bits_per_pixel() != 32 {
        return None;
    }
    let (w, h, stride) = (img.width(), img.height(), img.bytes_per_row());
    let data = img.data();
    let bytes = data.bytes();
    let (mut sum, mut n) = (0.0f64, 0u32);
    // Every other pixel is plenty for an average.
    for y in (0..h).step_by(2) {
        for x in (0..w).step_by(2) {
            let i = y * stride + x * 4;
            if i + 3 >= bytes.len() {
                break;
            }
            // Window captures are BGRA (32-bit little-endian, alpha first).
            let (bl, g, r) = (bytes[i] as f64, bytes[i + 1] as f64, bytes[i + 2] as f64);
            sum += (0.2126 * r + 0.7152 * g + 0.0722 * bl) / 255.0;
            n += 1;
        }
    }
    (n > 0).then(|| (sum / n as f64) as f32)
}

#[cfg(not(target_os = "macos"))]
fn sample(_b: &tauri::WebviewWindow) -> Option<f32> {
    None
}
