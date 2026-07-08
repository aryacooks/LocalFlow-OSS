//! macOS permission status + helpers for the first-run onboarding wizard.
//!
//! LocalFlow needs two TCC-gated permissions on macOS to work end to end:
//!   • **Microphone** — to record your voice (cpal capture triggers the prompt).
//!   • **Accessibility** — to type the transcribed text into other apps and run the
//!     optional global mouse hook (native CoreGraphics events).
//!
//! Without these the app silently does nothing, so the wizard surfaces their live
//! status and deep-links into the right System Settings pane. On non-macOS builds
//! the commands report everything as granted so the wizard is a trivial no-op.

use serde::Serialize;

#[derive(Serialize, Clone, Copy)]
pub struct PermissionStatus {
    /// True on macOS. Drives the macOS-specific wizard copy + the Accessibility step.
    pub is_macos: bool,
    /// True on Windows. The wizard shows a mic-only flow with Windows wording.
    pub is_windows: bool,
    /// Microphone access has been granted (recording will work). On Windows this
    /// reflects the Privacy → Microphone toggles; on macOS the TCC authorization.
    pub microphone: bool,
    /// Accessibility/Input-Monitoring granted (text injection + hooks will work).
    /// Always true off macOS — Windows needs no such grant for synthetic input.
    pub accessibility: bool,
    /// Required only for optional global mouse-button triggers on macOS.
    pub input_monitoring: bool,
}

#[cfg(target_os = "macos")]
mod imp {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
        fn CGPreflightListenEventAccess() -> bool;
        fn CGRequestListenEventAccess() -> bool;
        static kAXTrustedCheckOptionPrompt: *const std::ffi::c_void;
    }

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {
        static AVMediaTypeAudio: *const Object;
    }

    pub fn accessibility_granted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    /// Ask macOS to add this app to the Accessibility list and show the system
    /// prompt if it hasn't been asked before. Returns the current trust state.
    pub fn prompt_accessibility() -> bool {
        unsafe {
            let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt as _);
            let val = CFBoolean::true_value();
            let opts = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), val.as_CFType())]);
            AXIsProcessTrustedWithOptions(opts.as_concrete_TypeRef() as *const _)
        }
    }

    pub fn input_monitoring_granted() -> bool {
        unsafe { CGPreflightListenEventAccess() }
    }

    pub fn prompt_input_monitoring() -> bool {
        unsafe { CGRequestListenEventAccess() }
    }

    /// AVCaptureDevice authorization status for audio:
    /// 0 = notDetermined, 1 = restricted, 2 = denied, 3 = authorized.
    pub fn microphone_granted() -> bool {
        unsafe {
            let cls = class!(AVCaptureDevice);
            let status: isize = msg_send![cls, authorizationStatusForMediaType: AVMediaTypeAudio];
            status == 3
        }
    }

    /// Trigger the microphone prompt *through AVFoundation* (not cpal/CoreAudio).
    ///
    /// This matters: cpal opens the mic via CoreAudio, whose TCC grant doesn't
    /// refresh AVFoundation's cached `authorizationStatusForMediaType` within the
    /// running process — so after the user clicks Allow, the app kept reading the
    /// stale "not granted" until a restart. Requesting via `requestAccessForMediaType`
    /// makes AVFoundation the source of both the prompt and the status, so the next
    /// `microphone_granted()` poll returns the fresh value. Safe to call when already
    /// determined — it just fires the completion handler without a second prompt.
    pub fn request_microphone() {
        use block::ConcreteBlock;
        unsafe {
            let cls = class!(AVCaptureDevice);
            // AVFoundation copies (retains) the completion block, so our RcBlock can
            // drop at end of scope. The handler itself is a no-op; the onboarding UI
            // polls microphone_granted() to observe the result.
            let handler = ConcreteBlock::new(|_granted: bool| {}).copy();
            let _: () = msg_send![
                cls,
                requestAccessForMediaType: AVMediaTypeAudio
                completionHandler: handler
            ];
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    // Windows/Linux impose no Accessibility gate for synthetic keyboard input.
    pub fn accessibility_granted() -> bool {
        true
    }
    pub fn prompt_accessibility() -> bool {
        true
    }
    pub fn input_monitoring_granted() -> bool {
        true
    }
    pub fn prompt_input_monitoring() -> bool {
        true
    }

    #[cfg(windows)]
    pub fn microphone_granted() -> bool {
        // Windows gates mic access via two privacy toggles stored in the
        // ConsentStore:
        //   microphone\Value             -> master "Microphone access"
        //   microphone\NonPackaged\Value -> "Let desktop apps access your microphone"
        // A desktop (Tauri) app is blocked if either reads "Deny". A missing key
        // means the toggle was never changed from its default -> treat as allowed,
        // so we never show a false "not granted".
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        const BASE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let read = |path: &str| -> Option<String> {
            hkcu.open_subkey(path)
                .ok()
                .and_then(|k| k.get_value::<String, _>("Value").ok())
        };
        let allowed =
            |v: Option<String>| v.map(|s| !s.eq_ignore_ascii_case("Deny")).unwrap_or(true);
        allowed(read(BASE)) && allowed(read(&format!(r"{BASE}\NonPackaged")))
    }

    #[cfg(not(windows))]
    pub fn microphone_granted() -> bool {
        // Linux has no single uniform mic-permission gate to query.
        true
    }

    // Off macOS the mic prompt is handled by the OS on first capture; nothing to do.
    pub fn request_microphone() {}
}

/// Live permission snapshot for the onboarding wizard / Settings.
#[tauri::command]
pub fn get_permission_status() -> PermissionStatus {
    PermissionStatus {
        is_macos: cfg!(target_os = "macos"),
        is_windows: cfg!(windows),
        microphone: imp::microphone_granted(),
        accessibility: imp::accessibility_granted(),
        input_monitoring: imp::input_monitoring_granted(),
    }
}

/// Trigger the macOS Accessibility prompt (adds the app to the list) and return the
/// resulting trust state. No-op (returns true) off macOS.
#[tauri::command]
pub fn request_accessibility_permission() -> bool {
    imp::prompt_accessibility()
}

/// Prompt for the optional macOS Input Monitoring grant used by global mouse buttons.
#[tauri::command]
pub fn request_input_monitoring_permission() -> bool {
    imp::prompt_input_monitoring()
}

/// Show the microphone permission prompt via AVFoundation and return the current
/// status. On macOS this is the reliable way to prompt so the status refreshes
/// after granting (see `imp::request_microphone`). No-op-then-status elsewhere.
#[tauri::command]
pub fn request_microphone_permission() -> bool {
    imp::request_microphone();
    imp::microphone_granted()
}

/// Open a specific System Settings → Privacy pane. `pane` is one of
/// "microphone" | "accessibility" | "input-monitoring"; anything else opens the
/// Privacy & Security root. No-op off macOS.
#[tauri::command]
pub fn open_privacy_settings(pane: String) {
    #[cfg(target_os = "macos")]
    {
        let anchor = match pane.as_str() {
            "microphone" => "Privacy_Microphone",
            "accessibility" => "Privacy_Accessibility",
            "input-monitoring" => "Privacy_ListenEvent",
            _ => "Privacy",
        };
        let url = format!("x-apple.systempreferences:com.apple.preference.security?{anchor}");
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(windows)]
    {
        // ms-settings: URIs open the matching Windows Settings page.
        let uri = match pane.as_str() {
            "microphone" => "ms-settings:privacy-microphone",
            _ => "ms-settings:privacy",
        };
        // `start` resolves the protocol handler; the empty title arg is required.
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", uri])
            .spawn();
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = pane;
    }
}
