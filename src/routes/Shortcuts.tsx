import { useEffect, useState } from "react";
import { AlertTriangle, Check, ExternalLink, X } from "lucide-react";
import { getSetting, setSetting, reloadGlobalShortcut, getPermissionStatus, requestInputMonitoringPermission, openPrivacySettings, type PermissionStatus } from "../lib/ipc";
import { keyLabel } from "../lib/utils";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { CAPS_LOCK_KEYCODE, ESC_KEYCODE, FN_KEYCODE, isModifierKey, macKey, triggerKeycode } from "../lib/macKeys";
import ShieldCheck from "../components/ui/shield-check";

function getWindowsVkCode(code: string, keyCode: number): number {
  switch (code) {
    case "ShiftLeft": return 0xA0; // VK_LSHIFT
    case "ShiftRight": return 0xA1; // VK_RSHIFT
    case "ControlLeft": return 0xA2; // VK_LCONTROL
    case "ControlRight": return 0xA3; // VK_RCONTROL
    case "AltLeft": return 0xA4; // VK_LMENU
    case "AltRight": return 0xA5; // VK_RMENU
    case "CapsLock": return 0x14; // VK_CAPITAL
    case "Escape": return 0x1B; // VK_ESCAPE
    case "Space": return 0x20; // VK_SPACE
    case "Backquote": return 0xC0; // VK_OEM_3 (tilde)
    default: return keyCode;
  }
}

// Lightweight on/off switch matching the one used on the Settings page.
function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: () => void; label?: string; disabled?: boolean }) {
  return (
    <button className={`switch ${checked ? "on" : ""}`} onClick={onChange} role="switch" aria-checked={checked} aria-label={label} disabled={disabled}>
      <span />
    </button>
  );
}

// Short names for keycaps.
const mouseShort: Record<string, string> = {
  middle: "Middle click",
  right: "Right click",
  button4: "Mouse 4",
  button5: "Mouse 5",
};

const TRIGGER_KEYS = [
  "shortcut_toggle_enabled",
  "keybind_instant_enabled",
  "keybind_mouse_toggle_enabled",
  "keybind_mouse_instant_enabled",
  "cancel_esc_enabled",
] as const;
type TriggerKey = (typeof TRIGGER_KEYS)[number];

const mouseNameMap: Record<string, string> = {
  none: "Disabled",
  middle: "Middle Click (Button 3)",
  right: "Right Click (Button 2)",
  button4: "Mouse Button 4 (Back)",
  button5: "Mouse Button 5 (Forward)",
};

export default function ShortcutsPage() {
  const [shortcutToggle, setShortcutToggle] = useState("Alt+F");
  const [keybindKeyboardName, setKeybindKeyboardName] = useState("Alt+C");
  const [mouseToggle, setMouseToggle] = useState("none");
  const [mouseInstant, setMouseInstant] = useState("none");
  const [fnEnabled, setFnEnabled] = useState(false);
  // Primary key as a macOS keycode (setting "fn_trigger_key" = "key:<code>").
  const [primaryKey, setPrimaryKey] = useState(FN_KEYCODE);
  const pk = macKey(primaryKey);
  const [capturingKey, setCapturingKey] = useState(false);
  const [keyNote, setKeyNote] = useState("");
  // Per-trigger on/off (Settings keys "<trigger>_enabled"; missing = on).
  const [enabled, setEnabled] = useState<Record<TriggerKey, boolean>>({
    shortcut_toggle_enabled: true,
    keybind_instant_enabled: true,
    keybind_mouse_toggle_enabled: true,
    keybind_mouse_instant_enabled: true,
    cancel_esc_enabled: true,
  });
  const [permissions, setPermissions] = useState<PermissionStatus | null>(null);
  const [saveError, setSaveError] = useState("");
  // Rows render once settings are read, so switches don't flick from off to on.
  const [loaded, setLoaded] = useState(false);

  // Re-binding capture state
  // Types: toggle_key | instant_key | toggle_mouse | instant_mouse
  const [bindingType, setBindingType] = useState<"toggle_key" | "instant_key" | "toggle_mouse" | "instant_mouse" | null>(null);
  const [recordedKeys, setRecordedKeys] = useState<Array<{ key: string; code: string; keyCode: number }>>([]);
  const [recordedMouse, setRecordedMouse] = useState<{ button: string; name: string } | null>(null);


  const loadSettings = async () => {
    const toggle = await getSetting("shortcut_toggle");
    if (toggle) setShortcutToggle(toggle);

    const kbName = await getSetting("keybind_keyboard_name");
    if (kbName) setKeybindKeyboardName(kbName);

    const mToggle = await getSetting("keybind_mouse_toggle");
    if (mToggle) setMouseToggle(mToggle);

    const mInstant = await getSetting("keybind_mouse_instant");
    if (mInstant) setMouseInstant(mInstant);

    setFnEnabled((await getSetting("fn_quick_toggle")) === "true");
    setPrimaryKey(triggerKeycode(await getSetting("fn_trigger_key")));

    const flags = await Promise.all(TRIGGER_KEYS.map((k) => getSetting(k)));
    setEnabled(Object.fromEntries(TRIGGER_KEYS.map((k, i) => [k, flags[i] !== "false"])) as Record<TriggerKey, boolean>);
    setLoaded(true);
  };

  // Switch one trigger on/off; the backend re-registers so it takes effect at once.
  const toggleTrigger = async (key: TriggerKey) => {
    const next = !enabled[key];
    setEnabled((e) => ({ ...e, [key]: next }));
    try {
      await setSetting(key, String(next));
      await reloadGlobalShortcut();
    } catch (error) {
      console.error(error);
      setEnabled((e) => ({ ...e, [key]: !next }));
    }
  };

  // Fn is an extra trigger on macOS; the other shortcuts keep working alongside it.
  const toggleFn = async () => {
    const next = !fnEnabled;
    try {
      await setSetting("fn_quick_toggle", String(next));
      await reloadGlobalShortcut();
      setFnEnabled(next);
      if (next) await requestInputMonitoringPermission();
    } catch (error) {
      console.error(error);
    }
  };

  const changePrimaryKey = async (code: number) => {
    const prev = primaryKey;
    setPrimaryKey(code);
    try {
      await setSetting("fn_trigger_key", `key:${code}`);
      await reloadGlobalShortcut();
    } catch (error) {
      console.error(error);
      setPrimaryKey(prev);
    }
  };

  // "Change key": the backend reports the next key pressed anywhere (raw keycode, so
  // Fn, either-side modifiers and F-keys all work). Esc cancels.
  const startKeyCapture = async () => {
    setKeyNote("");
    try {
      await invoke("capture_trigger_key");
      setCapturingKey(true);
    } catch (error) {
      setKeyNote(String(error));
    }
  };
  const stopKeyCapture = () => {
    setCapturingKey(false);
    invoke("cancel_trigger_capture").catch(console.error);
  };

  useEffect(() => {
    if (!capturingKey) return;
    const off = listen<number>("trigger-key-captured", ({ payload: code }) => {
      setCapturingKey(false);
      if (code === ESC_KEYCODE) return;
      if (code === CAPS_LOCK_KEYCODE) {
        setKeyNote("Caps Lock can't be held down, so it can't be the primary key. Try another.");
        return;
      }
      changePrimaryKey(code);
    });
    // Leaving the page mid-capture shouldn't leave the next keystroke swallowed.
    return () => {
      off.then((f) => f());
      invoke("cancel_trigger_capture").catch(console.error);
    };
  }, [capturingKey]);

  useEffect(() => {
    loadSettings().catch(console.error).finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () =>
      getPermissionStatus()
        .then((status) => active && setPermissions(status))
        .catch(() => {});
    refresh();
    const id = setInterval(refresh, 2000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  // Capture event listeners for binding key combos and mouse buttons
  useEffect(() => {
    if (!bindingType) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setBindingType(null);
        setRecordedKeys([]);
        setRecordedMouse(null);
        return;
      }

      if (bindingType === "toggle_key" || bindingType === "instant_key") {
        let keyName = e.key;
        if (e.code === "Space") keyName = "Space";
        if (keyName === "Control") keyName = "Ctrl";
        if (keyName === "AltGraph") keyName = "Alt";

        if (keyName.length === 1) {
          keyName = keyName.toUpperCase();
        }

        const vk = getWindowsVkCode(e.code, e.keyCode);

        setRecordedKeys((prev) => {
          if (prev.some((k) => k.key === keyName)) return prev;
          if (prev.length >= 2) return prev;
          return [...prev, { key: keyName, code: e.code, keyCode: vk }];
        });
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (bindingType === "toggle_mouse" || bindingType === "instant_mouse") {
        e.preventDefault();
        e.stopPropagation();

        if (e.button === 0) return; // Ignore standard left click

        let btnVal = "";
        let btnName = "";

        if (e.button === 1) {
          btnVal = "middle";
          btnName = mouseNameMap.middle;
        } else if (e.button === 2) {
          btnVal = "right";
          btnName = mouseNameMap.right;
        } else if (e.button === 3) {
          btnVal = "button4";
          btnName = mouseNameMap.button4;
        } else if (e.button === 4) {
          btnVal = "button5";
          btnName = mouseNameMap.button5;
        }

        if (btnVal) {
          setRecordedMouse({ button: btnVal, name: btnName });
        }
      }
    };

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("mousedown", handleMouseDown, true);
    window.addEventListener("contextmenu", handleContextMenu, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("mousedown", handleMouseDown, true);
      window.removeEventListener("contextmenu", handleContextMenu, true);
    };
  }, [bindingType]);

  // Helper to format keyboard combos consistently (modifiers first)
  const getShortcutString = (keys: Array<{ key: string }>) => {
    const modifiersOrder = ["Ctrl", "Alt", "Shift", "Win"];
    const mods = keys.filter((k) => modifiersOrder.includes(k.key)).map((k) => k.key);
    const others = keys.filter((k) => !modifiersOrder.includes(k.key)).map((k) => k.key);

    mods.sort((a, b) => modifiersOrder.indexOf(a) - modifiersOrder.indexOf(b));

    return [...mods, ...others].join("+");
  };

  const hasNonModifier = (keys: Array<{ key: string }>) => {
    return keys.some((k) => !["Ctrl", "Alt", "Shift", "Win"].includes(k.key));
  };

  const getCandidateString = () => {
    return getShortcutString(recordedKeys);
  };

  // Keyboard validations
  const isKeyCountValid = recordedKeys.length >= 1 && recordedKeys.length <= 2;
  const isKeyComboValid = isKeyCountValid && hasNonModifier(recordedKeys);
  
  const keyboardConflict = (() => {
    if (!isKeyComboValid) return false;
    const candidate = getCandidateString();
    if (bindingType === "toggle_key" && candidate === keybindKeyboardName) return true;
    if (bindingType === "instant_key" && candidate === shortcutToggle) return true;
    return false;
  })();

  // Mouse validations
  const mouseConflict = (() => {
    if (!recordedMouse) return false;
    if (bindingType === "toggle_mouse" && recordedMouse.button !== "none" && recordedMouse.button === mouseInstant) return true;
    if (bindingType === "instant_mouse" && recordedMouse.button !== "none" && recordedMouse.button === mouseToggle) return true;
    return false;
  })();

  const handleSaveKeyboardBind = async () => {
    if (!isKeyComboValid || keyboardConflict) return;

    const candidate = getCandidateString();
    setSaveError("");

    if (bindingType === "toggle_key") {
      const previous = shortcutToggle;
      try {
        await setSetting("shortcut_toggle", candidate);
        await reloadGlobalShortcut();
        setShortcutToggle(candidate);
      } catch (err) {
        await setSetting("shortcut_toggle", previous).catch(() => {});
        await reloadGlobalShortcut().catch(() => {});
        setSaveError(`That shortcut is already used by macOS or another app. Your previous shortcut is still active. (${err})`);
        return;
      }
    } else if (bindingType === "instant_key") {
      const modifiersOrder = ["Ctrl", "Alt", "Shift", "Win"];
      const mainKey = recordedKeys.find((k) => !modifiersOrder.includes(k.key));
      const vk = mainKey ? mainKey.keyCode : 0;

      const previousName = keybindKeyboardName;
      const previousVk = await getSetting("keybind_keyboard_vk");
      // On macOS the hold key is registered via the global-shortcut plugin, so it
      // must be re-registered when changed. (Harmless on Windows — re-registers toggle.)
      try {
        await setSetting("keybind_keyboard_name", candidate);
        await setSetting("keybind_keyboard_vk", String(vk));
        await reloadGlobalShortcut();
        setKeybindKeyboardName(candidate);
      } catch (err) {
        await setSetting("keybind_keyboard_name", previousName).catch(() => {});
        await setSetting("keybind_keyboard_vk", previousVk || "67").catch(() => {});
        await reloadGlobalShortcut().catch(() => {});
        setSaveError(`That shortcut is already used by macOS or another app. Your previous shortcut is still active. (${err})`);
        return;
      }
    }

    setBindingType(null);
    setRecordedKeys([]);
  };

  const handleSaveMouseBind = async () => {
    if (!recordedMouse || mouseConflict) return;

    if (permissions?.is_macos && !permissions.input_monitoring) {
      await requestInputMonitoringPermission().catch(() => {});
      await openPrivacySettings("input-monitoring").catch(() => {});
    }

    // Setting a button also switches that trigger on.
    if (bindingType === "toggle_mouse") {
      await setSetting("keybind_mouse_toggle", recordedMouse.button);
      await setSetting("keybind_mouse_toggle_enabled", "true");
      setMouseToggle(recordedMouse.button);
      setEnabled((e) => ({ ...e, keybind_mouse_toggle_enabled: true }));
    } else if (bindingType === "instant_mouse") {
      await setSetting("keybind_mouse_instant", recordedMouse.button);
      await setSetting("keybind_mouse_instant_enabled", "true");
      setMouseInstant(recordedMouse.button);
      setEnabled((e) => ({ ...e, keybind_mouse_instant_enabled: true }));
    }
    // Refresh the backend's in-memory mouse-bind cache so the new trigger takes
    // effect immediately (the tap reads the cache, not the DB).
    await reloadGlobalShortcut();

    setBindingType(null);
    setRecordedMouse(null);
  };

  const renderKeycaps = (shortcutStr: string) => {
    return (
      <span className="keycap-row">
        {shortcutStr.split("+").map((key, idx) => (
          <span key={idx} className="keycap">
            {keyLabel(key)}
          </span>
        ))}
      </span>
    );
  };

  return (
    <div className="page narrow" style={{ position: "relative" }}>
      
      {/* Dynamic Keybinding and Mouse Button Overlay Modal */}
      {bindingType && (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "rgba(10, 10, 12, 0.65)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          display: "grid",
          placeItems: "center",
          zIndex: 9999,
        }}>
          <div className="glass-panel" style={{ width: 380, padding: 28, display: "flex", flexDirection: "column", gap: 18, border: "1px solid var(--separator-soft)" }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              {bindingType === "toggle_key" && "Record Toggle Shortcut"}
              {bindingType === "instant_key" && "Record Instant Shortcut"}
              {bindingType === "toggle_mouse" && "Bind Toggle Mouse Click"}
              {bindingType === "instant_mouse" && "Bind Instant Mouse Click"}
            </h3>

            {/* Keyboard Recording Layout */}
            {(bindingType === "toggle_key" || bindingType === "instant_key") && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <p style={{ margin: 0, fontSize: 13, color: "var(--secondary)", lineHeight: "18px" }}>
                  Press 1 or 2 keys to set your shortcut (for example a single key, or a modifier plus a key).
                </p>

                <div style={{ 
                  display: "flex", 
                  alignItems: "center", 
                  justifyContent: "center", 
                  minHeight: 52, 
                  backgroundColor: "rgba(0, 0, 0, 0.25)",
                  border: "1px solid var(--separator-soft)", 
                  borderRadius: 8, 
                  padding: 10 
                }}>
                  {recordedKeys.length === 0 ? (
                    <span style={{ fontSize: 14, color: "var(--tertiary)", fontWeight: 500, animation: "pulse 1.5s infinite" }}>
                      Listening for keys...
                    </span>
                  ) : (
                    <span className="keycap-row">
                      {recordedKeys.map((k, idx) => (
                        <span key={idx} className="keycap" style={{ padding: "4px 8px", fontSize: 13 }}>
                          {keyLabel(k.key)}
                        </span>
                      ))}
                    </span>
                  )}
                </div>

                {/* Validation Warnings */}
                {recordedKeys.length > 0 && !isKeyComboValid && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--warning)", fontSize: 11.5 }}>
                    <AlertTriangle size={14} />
                    <span>
                      {!hasNonModifier(recordedKeys) && "Add a non-modifier key (like a letter or number)."}
                    </span>
                  </div>
                )}

                {keyboardConflict && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--danger)", fontSize: 11.5 }}>
                    <AlertTriangle size={14} />
                    <span>This shortcut is already bound to the other trigger.</span>
                  </div>
                )}

                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button className="button danger" style={{ flex: 1, justifyContent: "center" }} onClick={() => setRecordedKeys([])}>
                    Clear
                  </button>
                  <button 
                    className="button primary" 
                    style={{ flex: 2, justifyContent: "center" }}
                    disabled={!isKeyComboValid || keyboardConflict}
                    onClick={handleSaveKeyboardBind}
                  >
                    <Check size={14} style={{ marginRight: 4 }} /> Confirm (OK)
                  </button>
                </div>
              </div>
            )}

            {/* Mouse Trigger Capturing Layout */}
            {(bindingType === "toggle_mouse" || bindingType === "instant_mouse") && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <p style={{ margin: 0, fontSize: 13, color: "var(--secondary)", lineHeight: "18px" }}>
                  Physically click the mouse button you want to configure (middle, right, or extra gaming side buttons 4 & 5).
                </p>

                <div style={{ 
                  display: "flex", 
                  alignItems: "center", 
                  justifyContent: "center", 
                  minHeight: 52, 
                  backgroundColor: "rgba(0, 0, 0, 0.25)",
                  border: "1px solid var(--separator-soft)", 
                  borderRadius: 8, 
                  padding: 10 
                }}>
                  {!recordedMouse ? (
                    <span style={{ fontSize: 14, color: "var(--tertiary)", fontWeight: 500, animation: "pulse 1.5s infinite" }}>
                      Click a mouse button to bind...
                    </span>
                  ) : (
                    <span style={{ color: "var(--accent)", fontWeight: 600, fontSize: 14 }}>
                      {recordedMouse.name}
                    </span>
                  )}
                </div>

                {mouseConflict && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--danger)", fontSize: 11.5 }}>
                    <AlertTriangle size={14} />
                    <span>This mouse button is already bound to the other trigger.</span>
                  </div>
                )}

                <button 
                  className="button primary" 
                  style={{ width: "100%", justifyContent: "center" }}
                  disabled={!recordedMouse || mouseConflict}
                  onClick={handleSaveMouseBind}
                >
                  <Check size={14} style={{ marginRight: 4 }} /> Confirm (OK)
                </button>
              </div>
            )}

            <button 
              className="button" 
              style={{ width: "100%", justifyContent: "center" }}
              onClick={() => {
                setBindingType(null);
                setRecordedKeys([]);
                setRecordedMouse(null);
              }}
            >
              <X size={14} style={{ marginRight: 4 }} /> Cancel
            </button>
          </div>
        </div>
      )}


      <div className="page-header">
        <div>
          <p className="page-kicker">Global triggers</p>
          <h2 className="page-title">Shortcuts</h2>
        </div>
      </div>

      {saveError && (
        <section className="glass-panel mac-callout" style={{ marginBottom: 18, borderColor: "var(--error)" }} role="alert">
          <AlertTriangle size={16} color="var(--error)" />
          <p className="row-desc" style={{ margin: 0, color: "var(--error)", fontWeight: 700 }}>{saveError}</p>
        </section>
      )}

      {loaded && (<>
      {/* PRIMARY: hold / double-tap one key (macOS). Fn by default. */}
      {permissions?.is_macos && (
        <section className={`glass-panel fn-hero ${fnEnabled ? "" : "is-off"}`} style={{ marginBottom: 18 }}>
          <div className="fn-hero-key" aria-hidden="true">{pk.cap}</div>
          <div className="fn-hero-body">
            <div className="fn-hero-title">
              {pk.name} <span className="fn-hero-badge">Primary</span>
            </div>
            <div className="fn-gestures">
              <div className="fn-gesture">
                <span className="fn-gesture-keys"><kbd className="keycap">{pk.short}</kbd></span>
                <span><b>Hold</b> to talk, let go to type</span>
              </div>
              <div className="fn-gesture is-main">
                <span className="fn-gesture-keys"><kbd className="keycap" aria-label={`${pk.short} twice`}>{pk.short}<sup className="fn-sq">2</sup></kbd></span>
                <span><b>Double-tap</b> to go hands-free · tap {pk.short} again to stop</span>
              </div>
            </div>
            <div className="fn-key-pick">
              <span>Key</span>
              {capturingKey ? (
                <>
                  <span className="fn-key-listen" role="status">Press any key…</span>
                  <button type="button" className="button fn-key-btn" onClick={stopKeyCapture}>Cancel</button>
                </>
              ) : (
                <>
                  <kbd className="keycap">{pk.short}</kbd>
                  <button type="button" className="button fn-key-btn" onClick={startKeyCapture}>Change key</button>
                  {primaryKey !== FN_KEYCODE && (
                    <button type="button" className="button fn-key-btn is-quiet" onClick={() => changePrimaryKey(FN_KEYCODE)}>Use Fn</button>
                  )}
                </>
              )}
              {keyNote ? <em className="is-warn">{keyNote}</em>
                : primaryKey === FN_KEYCODE ? null
                : isModifierKey(primaryKey) ? <em>Still works as a normal {pk.name.replace(/^(Right|Left) /, "")} key in combinations.</em>
                : <em>{pk.name} won't type on its own while this is on. It still works with ⌘, ⌃ or ⌥ held.</em>}
            </div>
          </div>
          <Switch checked={fnEnabled} onChange={toggleFn} label={pk.name} />
        </section>
      )}

      {/* SECTION 1: KEYBOARD */}
      <section className="section-label" style={{ marginBottom: 6 }}>{permissions?.is_macos ? "More shortcuts" : "Keyboard"}</section>
      <section className="glass-panel shortcut-list" style={{ marginBottom: 18 }}>
        <div className={`shortcut-row ${enabled.shortcut_toggle_enabled ? "" : "is-off"}`}>
          <div>
            <div className="setting-title">Toggle</div>
            <div className="setting-desc">Press to start, press again to stop</div>
          </div>
          <div className="shortcut-controls">
            {renderKeycaps(shortcutToggle)}
            <button className="button" onClick={() => setBindingType("toggle_key")}>Change</button>
            <Switch checked={enabled.shortcut_toggle_enabled} onChange={() => toggleTrigger("shortcut_toggle_enabled")} label="Toggle shortcut" />
          </div>
        </div>

        <div className={`shortcut-row ${enabled.keybind_instant_enabled ? "" : "is-off"}`}>
          <div>
            <div className="setting-title">Hold to talk</div>
            <div className="setting-desc">Hold the keys, let go to type</div>
          </div>
          <div className="shortcut-controls">
            {renderKeycaps(keybindKeyboardName)}
            <button className="button" onClick={() => setBindingType("instant_key")}>Change</button>
            <Switch checked={enabled.keybind_instant_enabled} onChange={() => toggleTrigger("keybind_instant_enabled")} label="Hold-to-talk shortcut" />
          </div>
        </div>

        {/* Esc-to-cancel exists only in the Windows keyboard hook. */}
        {permissions && !permissions.is_macos && (
          <div className={`shortcut-row ${enabled.cancel_esc_enabled ? "" : "is-off"}`}>
            <div>
              <div className="setting-title">Cancel</div>
              <div className="setting-desc">Stop and throw away the recording</div>
            </div>
            <div className="shortcut-controls">
              {renderKeycaps("Esc")}
              <Switch checked={enabled.cancel_esc_enabled} onChange={() => toggleTrigger("cancel_esc_enabled")} label="Esc to cancel" />
            </div>
          </div>
        )}
      </section>

      {/* SECTION 2: MOUSE */}
      <section className="section-label" style={{ marginBottom: 6 }}>Mouse</section>
      <section className="glass-panel shortcut-list" style={{ marginBottom: 18 }}>
        {permissions?.is_macos && !permissions.input_monitoring && (
          <div className="mac-callout" style={{ color: "var(--warning)", borderBottom: "1px solid var(--separator-soft)", paddingBottom: 12 }}>
            <AlertTriangle size={16} />
            <div style={{ flex: 1 }}>
              <div className="setting-title">Mouse buttons need Input Monitoring</div>
            </div>
            <button
              className="button"
              onClick={async () => {
                await requestInputMonitoringPermission().catch(() => {});
                await openPrivacySettings("input-monitoring").catch(() => {});
              }}
            >
              Allow <ExternalLink size={12} />
            </button>
          </div>
        )}

        {([
          { type: "toggle_mouse", key: "keybind_mouse_toggle_enabled", title: "Toggle", desc: "Click to start, click again to stop", value: mouseToggle },
          { type: "instant_mouse", key: "keybind_mouse_instant_enabled", title: "Hold to talk", desc: "Hold the button, let go to type", value: mouseInstant },
        ] as const).map((m) => {
          const set = m.value !== "none";
          const on = set && enabled[m.key];
          return (
            <div key={m.type} className={`shortcut-row ${on ? "" : "is-off"}`}>
              <div>
                <div className="setting-title">{m.title}</div>
                <div className="setting-desc">{m.desc}</div>
              </div>
              <div className="shortcut-controls">
                {set ? renderKeycaps(mouseShort[m.value] ?? m.value) : <span className="setting-desc">Not set</span>}
                <button className="button" onClick={() => setBindingType(m.type)}>{set ? "Change" : "Set"}</button>
                <Switch checked={on} disabled={!set} onChange={() => toggleTrigger(m.key)} label={`Mouse ${m.title}`} />
              </div>
            </div>
          );
        })}
      </section>

      </>)}

      <section className="glass-panel mac-callout" style={{ border: "1px solid var(--separator-soft)" }}>
        <ShieldCheck size={16} color="var(--success)" loop />
        <p className="row-desc" style={{ margin: 0 }}>
          Works in every app.
        </p>
      </section>
    </div>
  );
}
