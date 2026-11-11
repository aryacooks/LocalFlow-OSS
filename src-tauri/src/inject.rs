/// inject.rs — Cross-platform text injection + foreground app detection.
///
/// Clipboard is handled by `arboard`. Keystroke simulation is platform-specific:
/// - Windows: `enigo` (Ctrl+V / Ctrl+C).
/// - macOS: native CoreGraphics events. This avoids both enigo's off-main-thread
///   HIToolbox crash and the extra Automation prompt caused by AppleScript.

#[cfg(not(target_os = "macos"))]
use enigo::{Direction, Enigo, Key, Keyboard, Settings};

#[cfg(not(target_os = "macos"))]
fn new_enigo() -> Result<Enigo, String> {
    Enigo::new(&Settings::default()).map_err(|e| format!("Failed to init input simulator: {}", e))
}

#[cfg(target_os = "macos")]
async fn send_command_key(keycode: u16) -> Result<(), String> {
    if !crate::mac_permissions::get_permission_status().accessibility {
        return Err("Accessibility permission is required to type into other applications.".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
        use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| "Could not create a macOS keyboard event source".to_string())?;
        let down = CGEvent::new_keyboard_event(source.clone(), keycode, true)
            .map_err(|_| "Could not create a macOS key-down event".to_string())?;
        let up = CGEvent::new_keyboard_event(source, keycode, false)
            .map_err(|_| "Could not create a macOS key-up event".to_string())?;
        down.set_flags(CGEventFlags::CGEventFlagCommand);
        up.set_flags(CGEventFlags::CGEventFlagCommand);
        down.post(CGEventTapLocation::HID);
        up.post(CGEventTapLocation::HID);
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("macOS keyboard event task failed: {}", e))?
}

/// Simulate the paste shortcut (Cmd+V / Ctrl+V).
async fn send_paste() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        send_command_key(0x09).await // kVK_ANSI_V
    }
    #[cfg(not(target_os = "macos"))]
    {
        tauri::async_runtime::spawn_blocking(|| -> Result<(), String> {
            let mut enigo = new_enigo()?;
            enigo
                .key(Key::Control, Direction::Press)
                .map_err(|e| e.to_string())?;
            enigo
                .key(Key::Unicode('v'), Direction::Click)
                .map_err(|e| e.to_string())?;
            enigo
                .key(Key::Control, Direction::Release)
                .map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
        .map_err(|e| format!("paste task join error: {}", e))?
    }
}

/// Simulate the copy shortcut (Cmd+C / Ctrl+C).
async fn send_copy() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        send_command_key(0x08).await // kVK_ANSI_C
    }
    #[cfg(not(target_os = "macos"))]
    {
        tauri::async_runtime::spawn_blocking(|| -> Result<(), String> {
            let mut enigo = new_enigo()?;
            enigo
                .key(Key::Control, Direction::Press)
                .map_err(|e| e.to_string())?;
            enigo
                .key(Key::Unicode('c'), Direction::Click)
                .map_err(|e| e.to_string())?;
            enigo
                .key(Key::Control, Direction::Release)
                .map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
        .map_err(|e| format!("copy task join error: {}", e))?
    }
}

/// Inject text by simulating keystrokes (slower, but works in fields that block paste).
#[tauri::command]
pub async fn inject_text(text: String) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let mut enigo = new_enigo()?;
            enigo
                .text(&text)
                .map_err(|e| format!("Failed to type text: {}", e))?;
            Ok(())
        })
        .await
        .map_err(|e| format!("type task join error: {}", e))?
    }
    // On macOS, per-character typing would need enigo's TIS path (crashes off-main
    // thread), so fall back to the clipboard-paste route.
    #[cfg(target_os = "macos")]
    {
        inject_text_clipboard(text).await
    }
}

/// Paste text via the clipboard (fast for long texts). Saves and restores the
/// previous clipboard contents.
#[tauri::command]
pub async fn inject_text_clipboard(text: String) -> Result<(), String> {
    // Save current clipboard contents to restore later.
    let old_clipboard = get_clipboard_text().ok();

    set_clipboard_text(&text)?;
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;

    send_paste().await?;

    // Restore old clipboard contents after the paste settles.
    if let Some(old_text) = old_clipboard {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let _ = set_clipboard_text(&old_text);
    }

    Ok(())
}

/// Write text to the system clipboard.
fn set_clipboard_text(text: &str) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("Clipboard open: {}", e))?;
    clipboard
        .set_text(text.to_string())
        .map_err(|e| format!("Clipboard set: {}", e))
}

/// Read the current clipboard text.
pub fn get_clipboard_text() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("Clipboard open: {}", e))?;
    clipboard
        .get_text()
        .map_err(|e| format!("Clipboard get: {}", e))
}

/// Simulate Copy (Cmd/Ctrl+C) and return the selected text from the clipboard.
pub async fn copy_selected_text() -> Result<String, String> {
    send_copy().await?;
    // Wait for the target app to write to the clipboard.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    get_clipboard_text()
}

// ─── Foreground app detection (platform-specific) ───────────────────────────

/// Get the (friendly name, exe/bundle token) of the currently focused application.
/// The token is normalized to match the keys used in `cleanup::app_context`
/// (e.g. "chrome.exe", "code.exe") so per-app tone behaves the same on both OSes.
#[tauri::command]
pub fn get_foreground_app() -> (String, String) {
    #[cfg(windows)]
    {
        get_foreground_app_windows()
    }
    #[cfg(target_os = "macos")]
    {
        get_foreground_app_macos()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        ("Unknown".into(), "unknown".into())
    }
}

#[cfg(windows)]
fn get_foreground_app_windows() -> (String, String) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::GetModuleFileNameExW;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return ("Unknown".into(), "unknown.exe".into());
        }

        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));

        let proc = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);

        let exe_name = match proc {
            Ok(handle) => {
                let mut path_buf = [0u16; 260];
                let len = GetModuleFileNameExW(handle, None, &mut path_buf);
                let path = String::from_utf16_lossy(&path_buf[..len as usize]);
                let _ = CloseHandle(handle);
                std::path::Path::new(&path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown.exe")
                    .to_lowercase()
            }
            Err(_) => "unknown.exe".into(),
        };

        let app_name = exe_to_friendly_name(&exe_name);
        (app_name, exe_name)
    }
}

#[cfg(target_os = "macos")]
fn get_foreground_app_macos() -> (String, String) {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    let raw_name = unsafe {
        let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        let frontmost: *mut Object = msg_send![workspace, frontmostApplication];
        if frontmost.is_null() {
            return ("Unknown".into(), "unknown".into());
        }
        let name: *mut Object = msg_send![frontmost, localizedName];
        if name.is_null() {
            return ("Unknown".into(), "unknown".into());
        }
        let utf8: *const std::os::raw::c_char = msg_send![name, UTF8String];
        if utf8.is_null() {
            return ("Unknown".into(), "unknown".into());
        }
        CStr::from_ptr(utf8).to_string_lossy().trim().to_string()
    };

    if raw_name.is_empty() {
        return ("Unknown".into(), "unknown".into());
    }

    // Normalize the macOS app name into the same exe token cleanup.rs expects,
    // so context-aware tone (casual/formal/code/notes) behaves the same as Windows.
    let exe_token = macos_name_to_exe_token(&raw_name);
    (raw_name, exe_token)
}

/// Map a macOS application name to the Windows-style exe token used by app_context.
#[cfg(target_os = "macos")]
fn macos_name_to_exe_token(name: &str) -> String {
    match name.to_lowercase().as_str() {
        "google chrome" => "chrome.exe",
        "microsoft edge" => "msedge.exe",
        "firefox" => "firefox.exe",
        "safari" => "safari.exe",
        "code" | "visual studio code" | "electron" => "code.exe",
        "cursor" => "cursor.exe",
        "iterm2" | "terminal" | "alacritty" | "wezterm" | "kitty" => "windowsterminal.exe",
        "slack" => "slack.exe",
        "discord" => "discord.exe",
        "whatsapp" => "whatsapp.exe",
        "telegram" => "telegram.exe",
        "microsoft outlook" => "outlook.exe",
        "microsoft word" => "winword.exe",
        "microsoft excel" => "excel.exe",
        "notion" => "notion.exe",
        "obsidian" => "obsidian.exe",
        "notes" => "obsidian.exe",
        other => return format!("{}.app", other.replace(' ', "")),
    }
    .to_string()
}

#[cfg(windows)]
fn exe_to_friendly_name(exe: &str) -> String {
    match exe {
        "chrome.exe" => "Google Chrome",
        "msedge.exe" => "Microsoft Edge",
        "firefox.exe" => "Firefox",
        "code.exe" => "VS Code",
        "slack.exe" => "Slack",
        "discord.exe" => "Discord",
        "outlook.exe" => "Outlook",
        "winword.exe" => "Microsoft Word",
        "excel.exe" => "Microsoft Excel",
        "notion.exe" => "Notion",
        "obsidian.exe" => "Obsidian",
        "notepad.exe" => "Notepad",
        "notepad++.exe" => "Notepad++",
        "whatsapp.exe" => "WhatsApp",
        "teams.exe" => "Microsoft Teams",
        "zoom.exe" => "Zoom",
        "telegram.exe" => "Telegram",
        "cursor.exe" => "Cursor",
        "windowsterminal.exe" => "Windows Terminal",
        "powershell.exe" => "PowerShell",
        "cmd.exe" => "Command Prompt",
        _ => exe.trim_end_matches(".exe"),
    }
    .to_string()
}

/// Copy text to the clipboard (and leave it there) — the "Copy" button on the
/// nothing-was-pasted card.
#[tauri::command]
pub fn copy_to_clipboard(text: String) -> Result<(), String> {
    set_clipboard_text(&text)
}

/// Whether the focused UI element can take typed text, so we can tell the user when
/// a dictation had nowhere to go. `Some(false)` only when we're fairly sure (nothing
/// focused, or a focused element that isn't a text input); `None` when we can't tell.
#[cfg(target_os = "macos")]
pub fn focused_accepts_text() -> Option<bool> {
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::string::{CFString, CFStringRef};
    use std::ffi::c_void;

    type AXUIElementRef = *const c_void;
    const AX_OK: i32 = 0;
    const AX_NO_VALUE: i32 = -25212;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXUIElementCreateSystemWide() -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(el: AXUIElementRef, attr: CFStringRef, value: *mut CFTypeRef) -> i32;
        fn AXUIElementSetAttributeValue(el: AXUIElementRef, attr: CFStringRef, value: CFTypeRef) -> i32;
        fn AXUIElementSetMessagingTimeout(el: AXUIElementRef, seconds: f32) -> i32;
    }

    unsafe {
        if !AXIsProcessTrusted() {
            return None;
        }
        let sys = AXUIElementCreateSystemWide();
        if sys.is_null() {
            return None;
        }
        let sys = CFType::wrap_under_create_rule(sys as CFTypeRef);
        let sys_ref = sys.as_CFTypeRef() as AXUIElementRef;
        AXUIElementSetMessagingTimeout(sys_ref, 0.25);

        let copy = |el: AXUIElementRef, attr: &str| -> (i32, Option<CFType>) {
            let mut v: CFTypeRef = std::ptr::null();
            let key = CFString::new(attr);
            let err = AXUIElementCopyAttributeValue(el, key.as_concrete_TypeRef(), &mut v);
            let val = (err == AX_OK && !v.is_null()).then(|| CFType::wrap_under_create_rule(v));
            (err, val)
        };

        // Electron apps only expose their accessibility tree when asked; harmless elsewhere.
        let focused_app = match copy(sys_ref, "AXFocusedApplication") {
            (AX_OK, Some(app)) => {
                let key = CFString::new("AXManualAccessibility");
                AXUIElementSetAttributeValue(
                    app.as_CFTypeRef() as AXUIElementRef,
                    key.as_concrete_TypeRef(),
                    CFBoolean::true_value().as_CFTypeRef(),
                );
                Some(app)
            }
            _ => None,
        };

        // Ask a few times: an Electron app (Claude, Slack, VS Code…) only builds its
        // tree after the AXManualAccessibility request above, so the first answer can
        // be "nothing focused" even with the cursor in a text box.
        let mut verdict = None;
        for attempt in 0..3 {
            if attempt > 0 {
                std::thread::sleep(std::time::Duration::from_millis(120));
            }
            verdict = classify_focus(sys_ref, &copy);
            if verdict != Some(false) {
                return verdict;
            }
        }
        // Still "nothing focused". Many apps (Electron, games, custom views) never
        // report a focused element even with the cursor in a text box, so only call
        // it a miss when the app has no window in focus, or it's the Finder (the
        // desktop). Anything else: assume the paste landed.
        let Some(app) = focused_app else { return verdict };
        let app_ref = app.as_CFTypeRef() as AXUIElementRef;
        let has_window = matches!(copy(app_ref, "AXFocusedWindow"), (AX_OK, Some(_)));
        let is_finder = match copy(app_ref, "AXTitle") {
            (AX_OK, Some(t)) => t.downcast::<CFString>().map(|t| t.to_string() == "Finder").unwrap_or(false),
            _ => false,
        };
        if !has_window || is_finder {
            Some(false)
        } else {
            None
        }
    }
}

/// One look at the focused element. Some(true) = clearly a text box, Some(false) =
/// clearly nothing focused, None = can't tell (treated as "probably fine": the card
/// only shows when we're sure the text had nowhere to go).
#[cfg(target_os = "macos")]
unsafe fn classify_focus(
    sys_ref: *const std::ffi::c_void,
    copy: &dyn Fn(*const std::ffi::c_void, &str) -> (i32, Option<core_foundation::base::CFType>),
) -> Option<bool> {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::string::CFString;
    const AX_OK: i32 = 0;
    const AX_NO_VALUE: i32 = -25212;

    let (err, focused) = copy(sys_ref, "AXFocusedUIElement");
    let focused = match (err, focused) {
        (AX_OK, Some(f)) => f,
        (AX_NO_VALUE, _) => return Some(false), // nothing focused at all
        _ => return None,
    };
    let el = focused.as_CFTypeRef() as *const std::ffi::c_void;

    if let (AX_OK, Some(role)) = copy(el, "AXRole") {
        if let Some(role) = role.downcast::<CFString>() {
            if matches!(
                role.to_string().as_str(),
                "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField"
            ) {
                return Some(true);
            }
        }
    }
    // Rich editors (web contenteditable, code editors, terminals) report other roles
    // but still have a text cursor.
    if copy(el, "AXSelectedTextRange").0 == AX_OK {
        return Some(true);
    }
    if let (AX_OK, Some(v)) = copy(el, "AXEditable") {
        if v.downcast::<CFBoolean>().map(bool::from).unwrap_or(false) {
            return Some(true);
        }
    }
    // Something is focused but it doesn't look like a text box. Many apps (terminals,
    // canvases, custom editors) still take a paste, so don't claim it failed.
    None
}

#[cfg(not(target_os = "macos"))]
pub fn focused_accepts_text() -> Option<bool> {
    None
}

