import { useEffect, useState } from "react";
import { AlertTriangle, Check, ExternalLink, X } from "lucide-react";
import { getSetting, setSetting, reloadGlobalShortcut, getPermissionStatus, requestInputMonitoringPermission, openPrivacySettings, type PermissionStatus } from "../lib/ipc";
import { keyLabel, shortcutLabel } from "../lib/utils";
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
  const [permissions, setPermissions] = useState<PermissionStatus | null>(null);
  const [saveError, setSaveError] = useState("");

  // Re-binding capture state
  // Types: toggle_key | instant_key | toggle_mouse | instant_mouse
  const [bindingType, setBindingType] = useState<"toggle_key" | "instant_key" | "toggle_mouse" | "instant_mouse" | null>(null);
  const [recordedKeys, setRecordedKeys] = useState<Array<{ key: string; code: string; keyCode: number }>>([]);
  const [recordedMouse, setRecordedMouse] = useState<{ button: string; name: string } | null>(null);

  const showBanner = true;

  const loadSettings = async () => {
    const toggle = await getSetting("shortcut_toggle");
    if (toggle) setShortcutToggle(toggle);

    const kbName = await getSetting("keybind_keyboard_name");
    if (kbName) setKeybindKeyboardName(kbName);

    const mToggle = await getSetting("keybind_mouse_toggle");
    if (mToggle) setMouseToggle(mToggle);

    const mInstant = await getSetting("keybind_mouse_instant");
    if (mInstant) setMouseInstant(mInstant);
  };

  useEffect(() => {
    loadSettings().catch(console.error);
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

    if (bindingType === "toggle_mouse") {
      await setSetting("keybind_mouse_toggle", recordedMouse.button);
      setMouseToggle(recordedMouse.button);
    } else if (bindingType === "instant_mouse") {
      await setSetting("keybind_mouse_instant", recordedMouse.button);
      setMouseInstant(recordedMouse.button);
    }
    // Refresh the backend's in-memory mouse-bind cache so the new trigger takes
    // effect immediately (the tap reads the cache, not the DB).
    await reloadGlobalShortcut();

    setBindingType(null);
    setRecordedMouse(null);
  };

  const handleDisableMouseBind = async (type: "toggle" | "instant") => {
    if (type === "toggle") {
      await setSetting("keybind_mouse_toggle", "none");
      setMouseToggle("none");
    } else {
      await setSetting("keybind_mouse_instant", "none");
      setMouseInstant("none");
    }
    await reloadGlobalShortcut();
  };

  // Compact mouse-button labels for the banner summary tag.
  const shortMouseLabel = (v: string): string | null => {
    switch (v) {
      case "middle": return "Middle click";
      case "right": return "Right click";
      case "button4": return "Mouse 4";
      case "button5": return "Mouse 5";
      default: return null;
    }
  };

  // Reflect the actual configured mouse triggers (toggle + instant), de-duped. Falls
  // back to a neutral label when no mouse button is bound.
  const mouseTagLabel = (() => {
    const parts = [shortMouseLabel(mouseToggle), shortMouseLabel(mouseInstant)].filter(
      (p): p is string => p !== null
    );
    if (parts.length === 0) return "No mouse trigger";
    return Array.from(new Set(parts)).join(" & ");
  })();

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

      {showBanner && (
        <div className="banner-card" style={{ backgroundImage: "url('/Shortcuts Background.png')" }}>
          <div className="banner-content">
            <h2 className="banner-title">One key to <em>rule</em> them all.</h2>
            <p className="banner-desc">
              Pick the keys or mouse buttons that start and stop dictation. Set it once, then talk to type anywhere. Your keyboard finally gets a break, and so do your fingers.
            </p>
            <div className="banner-actions">
              <span className="banner-tag">{shortcutLabel(shortcutToggle)} Toggle</span>
              <span className="banner-tag">{shortcutLabel(keybindKeyboardName)} Instant</span>
              <span className="banner-tag">{mouseTagLabel}</span>
            </div>
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

      {/* SECTION 1: KEYBOARD SHORTCUTS */}
      <section className="section-label" style={{ marginBottom: 6 }}>1. Keyboard hotkeys</section>
      <section className="glass-panel" style={{ marginBottom: 18, display: "flex", flexDirection: "column", gap: 12 }}>
        
        {/* Toggle Dictation */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div className="setting-title">Toggle Dictation</div>
            <div className="setting-desc" style={{ marginTop: 2 }}>Press combo to start recording, press again to stop.</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {renderKeycaps(shortcutToggle)}
            <button className="button" onClick={() => setBindingType("toggle_key")}>
              Change
            </button>
          </div>
        </div>

        {/* Instant Dictation */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--separator-soft)", paddingTop: 12 }}>
          <div>
            <div className="setting-title">Instant Dictation (Hold to Talk)</div>
            <div className="setting-desc" style={{ marginTop: 2 }}>Hold keys together to speak, release them to transcribe.</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {renderKeycaps(keybindKeyboardName)}
            <button className="button" onClick={() => setBindingType("instant_key")}>
              Change
            </button>
          </div>
        </div>

        {/* Escape note */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--separator-soft)", paddingTop: 12 }}>
          <div>
            <div className="setting-title">Cancel Dictation</div>
            <div className="setting-desc" style={{ marginTop: 2 }}>Instantly stops and discards recording without transcribing.</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, paddingRight: 6 }}>
            {renderKeycaps("Esc")}
          </div>
        </div>

      </section>

      {/* SECTION 2: MOUSE TRIGGERS */}
      <section className="section-label" style={{ marginBottom: 6 }}>2. Mouse button triggers</section>
      <section className="glass-panel" style={{ marginBottom: 18, display: "flex", flexDirection: "column", gap: 12 }}>
        {permissions?.is_macos && !permissions.input_monitoring && (
          <div className="mac-callout" style={{ color: "var(--warning)", borderBottom: "1px solid var(--separator-soft)", paddingBottom: 12 }}>
            <AlertTriangle size={16} />
            <div style={{ flex: 1 }}>
              <div className="setting-title">Allow Input Monitoring for mouse triggers</div>
              <div className="setting-desc">
                Keyboard shortcuts already work. macOS needs this extra permission only if you want a mouse button to start dictation.
              </div>
            </div>
            <button
              className="button"
              onClick={async () => {
                await requestInputMonitoringPermission().catch(() => {});
                await openPrivacySettings("input-monitoring").catch(() => {});
              }}
            >
              Open Settings <ExternalLink size={12} />
            </button>
          </div>
        )}
        
        {/* Toggle Dictation Mouse */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div className="setting-title">Toggle Dictation Trigger</div>
            <div className="setting-desc" style={{ marginTop: 2 }}>Click mouse button to start/stop dictation.</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: mouseToggle === "none" ? "var(--secondary)" : "var(--accent)", fontWeight: 500, marginRight: 4 }}>
              {mouseNameMap[mouseToggle]}
            </span>
            {mouseToggle !== "none" && (
              <button className="button danger" onClick={() => handleDisableMouseBind("toggle")}>
                Disable
              </button>
            )}
            <button className="button" onClick={() => setBindingType("toggle_mouse")}>
              Configure
            </button>
          </div>
        </div>

        {/* Instant Dictation Mouse */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--separator-soft)", paddingTop: 12 }}>
          <div>
            <div className="setting-title">Instant Dictation Trigger (Hold to Talk)</div>
            <div className="setting-desc" style={{ marginTop: 2 }}>Hold mouse button to talk, release it to transcribe.</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: mouseInstant === "none" ? "var(--secondary)" : "var(--accent)", fontWeight: 500, marginRight: 4 }}>
              {mouseNameMap[mouseInstant]}
            </span>
            {mouseInstant !== "none" && (
              <button className="button danger" onClick={() => handleDisableMouseBind("instant")}>
                Disable
              </button>
            )}
            <button className="button" onClick={() => setBindingType("instant_mouse")}>
              Configure
            </button>
          </div>
        </div>

      </section>

      <section className="glass-panel mac-callout" style={{ border: "1px solid var(--separator-soft)" }}>
        <ShieldCheck size={16} color="var(--success)" loop />
        <p className="row-desc" style={{ margin: 0 }}>
          Your shortcuts work everywhere on your computer, every app, from a Word doc to the Roblox game you're definitely not playing right now.
        </p>
      </section>
    </div>
  );
}
