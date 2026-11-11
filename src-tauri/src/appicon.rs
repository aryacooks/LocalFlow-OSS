/// appicon.rs — real app icons for the History list.
///
/// History stores each dictation's app as a name ("Claude") and a token ("claude.app").
/// On macOS we find that app with NSWorkspace and return its Dock icon as a small PNG
/// data URL. Results (including misses) are cached, so each app is looked up once.
/// Other platforms return None and the UI shows a letter badge instead.
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Mutex;

static CACHE: Lazy<Mutex<HashMap<String, Option<String>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// PNG data URL of the app's icon, about 64 px, or None if the app can't be found.
#[tauri::command]
pub async fn get_app_icon(app_name: String, app_exe: String) -> Option<String> {
    let key = format!("{}|{}", app_name.to_lowercase(), app_exe.to_lowercase());
    if let Some(hit) = CACHE.lock().ok().and_then(|c| c.get(&key).cloned()) {
        return hit;
    }
    let found = tauri::async_runtime::spawn_blocking(move || lookup(&app_name, &app_exe))
        .await
        .ok()
        .flatten();
    if let Ok(mut c) = CACHE.lock() {
        c.insert(key, found.clone());
    }
    found
}

#[cfg(target_os = "macos")]
fn lookup(app_name: &str, app_exe: &str) -> Option<String> {
    use base64::Engine;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CString;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSPoint { x: f64, y: f64 }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSSize { width: f64, height: f64 }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSRect { origin: NSPoint, size: NSSize }

    // Some apps put invisible direction marks in their names (WhatsApp: U+200E).
    let clean = |s: &str| -> String {
        s.chars().filter(|c| !matches!(*c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')).collect()
    };
    let (app_name, app_exe) = (clean(app_name), clean(app_exe));
    let (app_name, app_exe) = (app_name.as_str(), app_exe.as_str());
    // Names to try: the stored name, then the token without ".app"/".exe".
    let stem = app_exe
        .trim_end_matches(".app")
        .trim_end_matches(".exe")
        .to_string();
    let mut names: Vec<String> = Vec::new();
    for n in [app_name.trim().to_string(), stem] {
        if !n.is_empty() && !n.eq_ignore_ascii_case("unknown") && !names.iter().any(|m| m.eq_ignore_ascii_case(&n)) {
            names.push(n);
        }
    }

    unsafe {
        let ws: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        if ws.is_null() {
            return None;
        }
        let nsstring = |s: &str| -> *mut Object {
            let c = CString::new(s).unwrap_or_default();
            msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()]
        };

        // fullPathForApplication: finds the app by name (case-insensitive, any folder).
        let mut path: *mut Object = std::ptr::null_mut();
        for n in &names {
            let p: *mut Object = msg_send![ws, fullPathForApplication: nsstring(n)];
            if !p.is_null() {
                path = p;
                break;
            }
        }
        if path.is_null() {
            return None;
        }

        let icon: *mut Object = msg_send![ws, iconForFile: path];
        if icon.is_null() {
            return None;
        }
        // Ask for a 64 px image; AppKit picks the best representation for that size.
        let mut rect = NSRect { origin: NSPoint { x: 0.0, y: 0.0 }, size: NSSize { width: 64.0, height: 64.0 } };
        let nil: *mut Object = std::ptr::null_mut();
        let cg: *mut std::ffi::c_void = msg_send![icon, CGImageForProposedRect: &mut rect context: nil hints: nil];
        if cg.is_null() {
            return None;
        }
        let rep: *mut Object = msg_send![class!(NSBitmapImageRep), alloc];
        let rep: *mut Object = msg_send![rep, initWithCGImage: cg];
        if rep.is_null() {
            return None;
        }
        let props: *mut Object = msg_send![class!(NSDictionary), dictionary];
        // NSBitmapImageFileTypePNG = 4
        let png: *mut Object = msg_send![rep, representationUsingType: 4u64 properties: props];
        let out = if png.is_null() {
            None
        } else {
            let len: usize = msg_send![png, length];
            let bytes: *const u8 = msg_send![png, bytes];
            (!bytes.is_null() && len > 0).then(|| {
                let data = std::slice::from_raw_parts(bytes, len);
                format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(data))
            })
        };
        let _: () = msg_send![rep, release];
        out
    }
}

#[cfg(not(target_os = "macos"))]
fn lookup(_app_name: &str, _app_exe: &str) -> Option<String> {
    None
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn finds_finder_icon() {
        let r = super::lookup("Finder", "finder.app");
        eprintln!("finder: {:?}", r.as_ref().map(|s| s.len()));
        let r2 = super::lookup("Claude", "claude.app");
        eprintln!("claude: {:?}", r2.as_ref().map(|s| s.len()));
        assert!(r.is_some());
    }
}
