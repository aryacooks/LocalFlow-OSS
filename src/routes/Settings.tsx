import { useEffect, useRef, useState } from "react";
import { Globe, Keyboard, Mic, MonitorCheck, Shield, History, Circle, Eye, Volume2, Move, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, LocateFixed, Check, CircleAlert, ExternalLink, Accessibility, RotateCcw, Power, Minus, Plus } from "lucide-react";
import { listAudioDevices, setAudioDevice, setSetting, getSetting, setBubbleSize, BUBBLE_SCALE_MIN, BUBBLE_SCALE_MAX, BUBBLE_SCALE_STEP, setBubbleVisible, setEarconsEnabled, getBubblePosition, nudgeBubble, resetBubblePosition, getPermissionStatus, requestAccessibilityPermission, requestMicrophonePermission, openPrivacySettings, type PermissionStatus } from "../lib/ipc";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { shortcutLabel } from "../lib/utils";
import { emit } from "@tauri-apps/api/event";
import { useAppStore } from "../lib/store";
import { Link } from "react-router-dom";

// LocalFlow transcribes English and Hindi only. "Auto-detect" picks between the two
// per clip (multilingual model required); the backend never emits a third language.
const LANGUAGES = [
  { code: "auto", label: "Auto-detect (English / Hindi)" },
  { code: "en", label: "English" },
  { code: "hi", label: "Hindi" },
];

function Section({
  title,
  children,
  attention,
  className,
}: {
  title: string;
  children: React.ReactNode;
  /** Pulse the section gold to flag it needs the user's attention (e.g. a missing permission). */
  attention?: boolean;
  className?: string;
}) {
  return (
    <section
      style={{ marginBottom: 18 }}
      className={["settings-section", attention ? "section-attn" : "", className ?? ""].filter(Boolean).join(" ")}
    >
      <div className="section-label">{title}</div>
      <div className="table-panel">{children}</div>
    </section>
  );
}

function SettingRow({
  icon: Icon,
  label,
  description,
  children,
}: {
  icon?: React.ElementType;
  label: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="setting-row">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {Icon && <Icon size={16} color="var(--secondary)" />}
        <div>
          <div className="setting-title">{label}</div>
          {description && <div className="setting-desc">{description}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

function Switch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button className={`switch ${checked ? "on" : ""}`} onClick={onChange} aria-pressed={checked}>
      <span />
    </button>
  );
}

// Permissions panel (macOS + Windows). Shows live granted/not-granted status for
// the permissions LocalFlow needs to work fully, with one-click grant + deep links.
// macOS needs Microphone + Accessibility; Windows needs only Microphone.
function PermissionsSection() {
  const [perms, setPerms] = useState<PermissionStatus | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = () =>
      getPermissionStatus()
        .then((p) => active && setPerms(p))
        .catch(() => {});
    refresh();
    const id = setInterval(refresh, 2000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  // Shown on macOS + Windows; other platforms have no permission gate to surface.
  if (!perms || (!perms.is_macos && !perms.is_windows)) return null;

  const rerunSetup = async () => {
    await setSetting("onboarding_done", "false").catch(() => {});
    window.location.reload();
  };

  const Row = ({
    icon: Icon,
    label,
    description,
    granted,
    pane,
    onGrant,
  }: {
    icon: React.ElementType;
    label: string;
    description: React.ReactNode;
    granted: boolean;
    pane: string;
    onGrant?: () => void;
  }) => (
    <SettingRow icon={Icon} label={label} description={description}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11.5,
            fontWeight: 800,
            color: granted ? "var(--success)" : "var(--danger)",
          }}
        >
          {granted ? <Check size={13} strokeWidth={3} /> : <CircleAlert size={13} strokeWidth={2.6} />}
          {granted ? "Granted" : "Not granted"}
        </span>
        {!granted && (
          <button
            className="button"
            style={{ fontSize: 11, fontWeight: 700, padding: "5px 10px", display: "inline-flex", alignItems: "center", gap: 5 }}
            onClick={() => {
              onGrant?.();
              openPrivacySettings(pane);
            }}
          >
            Grant <ExternalLink size={11} />
          </button>
        )}
      </div>
    </SettingRow>
  );

  // Any required permission still missing → pulse the whole section for attention.
  const missingPermission = !perms.microphone || (perms.is_macos && !perms.accessibility);

  return (
    <Section
      title={perms.is_macos ? "Permissions (macOS)" : "Permissions (Windows)"}
      attention={missingPermission}
      className="settings-permissions"
    >
      <Row
        icon={Mic}
        label="Microphone"
        description={
          <>
            <strong style={{ color: "var(--label)" }}>Only listens while you're dictating</strong> — when you press your <strong style={{ color: "var(--label)" }}>shortcut</strong> to start recording, and stops the moment you finish.
            <br />
            <mark className="perm-hl" style={{ display: "inline-block", marginTop: 4 }}>It never listens in the background.</mark>
          </>
        }
        granted={perms.microphone}
        pane="microphone"
        onGrant={() => requestMicrophonePermission().catch(() => {})}
      />
      {perms.is_macos && (
        <Row
          icon={Accessibility}
          label="Accessibility"
          description={
            <>
              Lets LocalFlow <strong style={{ color: "var(--label)" }}>type the transcribed text into whatever app you're using</strong>, and see which app is in front so it can match its style. Without it, <mark className="perm-hl">LocalFlow can still turn your voice into text but can't paste it anywhere.</mark>
            </>
          }
          granted={perms.accessibility}
          pane="accessibility"
          onGrant={() => requestAccessibilityPermission().catch(() => {})}
        />
      )}
      <SettingRow icon={RotateCcw} label="Setup guide" description="Walk through first-time setup again">
        <button
          className="button"
          style={{ fontSize: 11, fontWeight: 700, padding: "5px 10px" }}
          onClick={rerunSetup}
        >
          Re-run setup
        </button>
      </SettingRow>
    </Section>
  );
}

// A little game-controller D-pad for nudging the floating bubble around the screen.
// Arrows move it a step at a time (hold to glide); the center snaps back to default.
function DPad({
  onNudge,
  onReset,
  custom,
}: {
  onNudge: (dx: number, dy: number) => void;
  onReset: () => void;
  custom: boolean;
}) {
  const STEP = 0.04; // 4% of the screen per tick
  const holdActive = useRef(false);

  // Stop any in-flight hold loop if the page unmounts mid-press.
  useEffect(() => () => { holdActive.current = false; }, []);

  const startHold = (dx: number, dy: number) => {
    if (holdActive.current) return;
    holdActive.current = true;
    const run = async () => {
      while (holdActive.current) {
        onNudge(dx, dy);
        await new Promise((r) => setTimeout(r, 80));
      }
    };
    run();
  };
  const stopHold = () => {
    holdActive.current = false;
  };

  const padStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1.5px solid var(--separator)",
    borderRadius: 8,
    background: "var(--separator-soft)",
    color: "var(--label)",
    cursor: "pointer",
    userSelect: "none",
  };

  const arrow = (dx: number, dy: number, Icon: React.ElementType, label: string, area: string) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      onPointerDown={(e) => {
        e.preventDefault();
        startHold(dx, dy);
      }}
      onPointerUp={stopHold}
      onPointerLeave={stopHold}
      onPointerCancel={stopHold}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onNudge(dx, dy);
        }
      }}
      style={{ ...padStyle, gridArea: area }}
    >
      <Icon size={15} />
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 30px)",
          gridTemplateRows: "repeat(3, 30px)",
          gridTemplateAreas: `". up ." "left home right" ". down ."`,
          gap: 4,
        }}
      >
        {arrow(0, -STEP, ArrowUp, "Move bubble up", "up")}
        {arrow(-STEP, 0, ArrowLeft, "Move bubble left", "left")}
        <button
          type="button"
          aria-label="Reset bubble to default position"
          title={custom ? "Reset to default position" : "Already at default position"}
          onClick={onReset}
          style={{
            ...padStyle,
            gridArea: "home",
            background: custom ? "var(--accent)" : "transparent",
            color: custom ? "var(--accent-text)" : "var(--tertiary)",
            borderColor: custom ? "var(--accent)" : "var(--separator)",
          }}
        >
          <LocateFixed size={14} />
        </button>
        {arrow(STEP, 0, ArrowRight, "Move bubble right", "right")}
        {arrow(0, STEP, ArrowDown, "Move bubble down", "down")}
      </div>
      <span style={{ fontSize: 10, fontWeight: 600, color: custom ? "var(--accent)" : "var(--tertiary)" }}>
        {custom ? "Custom spot" : "Default spot"}
      </span>
    </div>
  );
}

// Stepper for the floating bubble's size. The stored value is either "auto" (let the
// display geometry decide) or an explicit scale multiplier.
//
// Auto has no number of its own, so the first press has to start from somewhere: it
// starts from AUTO_BASELINE, the scale a typical laptop resolves to. Stepping from
// there feels continuous rather than jumping to 50% or 500%.
const AUTO_BASELINE = 1.2;

function BubbleSizeStepper({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const isAuto = value === "auto";
  const parsed = Number.parseFloat(value);
  const scale = isAuto || !Number.isFinite(parsed) ? AUTO_BASELINE : parsed;

  // Float steps drift (1.1 + 0.1 = 1.2000000000000002), which would show as 120.00001%
  // and never compare equal to the bounds. Round every step to one decimal.
  const step = (delta: number) => {
    const next = Math.round((scale + delta) * 10) / 10;
    const clamped = Math.min(Math.max(next, BUBBLE_SCALE_MIN), BUBBLE_SCALE_MAX);
    onChange(clamped.toFixed(2));
  };

  const atMin = !isAuto && scale <= BUBBLE_SCALE_MIN;
  const atMax = !isAuto && scale >= BUBBLE_SCALE_MAX;

  return (
    <div className="bubble-size">
      <div className="bubble-size-stepper">
        <button
          type="button"
          onClick={() => step(-BUBBLE_SCALE_STEP)}
          disabled={atMin}
          aria-label="Make the bubble smaller"
          title="Smaller"
        >
          <Minus size={14} />
        </button>
        <span
          className="bubble-size-value"
          aria-live="polite"
          title={isAuto ? "Sized automatically from your display" : undefined}
        >
          {isAuto ? "Auto" : `${Math.round(scale * 100)}%`}
        </span>
        <button
          type="button"
          onClick={() => step(BUBBLE_SCALE_STEP)}
          disabled={atMax}
          aria-label="Make the bubble bigger"
          title="Bigger"
        >
          <Plus size={14} />
        </button>
      </div>
      <button
        type="button"
        className="bubble-size-auto"
        onClick={() => onChange("auto")}
        disabled={isAuto}
      >
        Auto
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const { privacyMode, togglePrivacy, language, setLanguage } = useAppStore();
  const [devices, setDevices] = useState<string[]>([]);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [saveHistory, setSaveHistory] = useState(true);
  // Bubble size: "auto" (geometry heuristic) or a scale multiplier as a string.
  const [bubbleSize, setBubbleSizeState] = useState("auto");
  const [bubbleColor, setBubbleColorState] = useState("white");
  // Whether the floating bubble has been moved off its default bottom-right spot.
  const [bubbleCustom, setBubbleCustom] = useState(false);
  // Display feature switches (all on by default). Disabling one requires the
  // "exile" confirmation below.
  const [showBubble, setShowBubble] = useState(true);
  const [playSounds, setPlaySounds] = useState(true);
  const [autostart, setAutostart] = useState(false);
  const [pendingDisable, setPendingDisable] = useState<null | "bubble" | "sounds">(null);
  const [exileText, setExileText] = useState("");
  const showBanner = true;
  
  // Custom Dynamic Shortcuts Settings State
  const [shortcutToggle, setShortcutToggle] = useState("Ctrl+Alt");
  const [keybindKeyboardName, setKeybindKeyboardName] = useState("Ctrl+Q");
  const [keybindKeyboardMode, setKeybindKeyboardMode] = useState("hold");
  const [keybindMouseName, setKeybindMouseName] = useState("Middle Click");
  const [keybindMouseMode, setKeybindMouseMode] = useState("hold");

  useEffect(() => {
    Promise.all([listAudioDevices(), getSetting("mic_device")])
      .then(([devs, savedDevice]) => {
        setDevices(devs);
        if (devs.length === 0) return;
        const selected = savedDevice && devs.includes(savedDevice) ? savedDevice : devs[0];
        setSelectedDevice(selected);
        setAudioDevice(selected).catch(console.error);
        if (selected !== savedDevice) setSetting("mic_device", selected).catch(console.error);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    const loadSettings = async () => {
      const toggle = await getSetting("shortcut_toggle");
      if (toggle) setShortcutToggle(toggle);

      const saveHist = await getSetting("save_history");
      if (saveHist) setSaveHistory(saveHist === "true");

      const bs = await getSetting("bubble_size");
      if (bs) setBubbleSizeState(bs);

      const bc = await getSetting("bubble_color");
      if (bc === "white" || bc === "black") setBubbleColorState(bc);

      const bp = await getBubblePosition().catch(() => null);
      setBubbleCustom(!!bp);

      setShowBubble((await getSetting("show_bubble")) !== "false");
      setPlaySounds((await getSetting("play_sounds")) !== "false");
      setAutostart(await isAutostartEnabled().catch(() => false));

      const kbName = await getSetting("keybind_keyboard_name");
      const kbMode = await getSetting("keybind_keyboard_mode");
      const kbOld = await getSetting("keybind_keyboard");

      if (kbName) {
        setKeybindKeyboardName(kbName);
      } else if (kbOld) {
        const mapping: Record<string, string> = {
          rshift_ralt: "Right Alt",
          rshift_double: "Right Shift",
          ralt_hold: "Right Alt",
          caps_hold: "Caps Lock",
          tilde_hold: "Tilde (~)",
        };
        setKeybindKeyboardName(mapping[kbOld] ?? "Right Alt");
      } else {
        setKeybindKeyboardName("Ctrl+Q");
      }

      if (kbMode) {
        setKeybindKeyboardMode(kbMode);
      } else if (kbOld) {
        setKeybindKeyboardMode(kbOld.includes("double") || kbOld === "rshift_ralt" ? "double_tap" : "hold");
      } else {
        setKeybindKeyboardMode("hold");
      }

      const mouse = await getSetting("keybind_mouse");
      const mouseName = await getSetting("keybind_mouse_name");
      const mouseMode = await getSetting("keybind_mouse_mode");
      
      if (mouseName) {
        setKeybindMouseName(mouseName);
      } else if (mouse && mouse !== "none") {
        const mapping: Record<string, string> = {
          middle: "Middle Click",
          back: "Mouse Button 4",
          forward: "Mouse Button 5",
          right: "Right Click",
        };
        setKeybindMouseName(mapping[mouse] ?? "Middle Click");
      } else if (mouse === "none") {
        setKeybindMouseName("Disabled");
      } else {
        setKeybindMouseName("Middle Click");
      }
      if (mouseMode) setKeybindMouseMode(mouseMode);
    };
    loadSettings().catch(console.error);
  }, []);

  const save = async (key: string, value: string) => setSetting(key, value).catch(console.error);

  // Bubble-position D-pad handlers.
  const nudgePos = (dx: number, dy: number) => {
    nudgeBubble(dx, dy)
      .then((pos) => setBubbleCustom(!!pos))
      .catch(console.error);
  };
  const resetPos = () => {
    resetBubblePosition()
      .then(() => setBubbleCustom(false))
      .catch(console.error);
  };

  type DisplayFeature = "bubble" | "sounds";

  const featureLabel = (k: DisplayFeature) =>
    k === "bubble" ? "the floating bubble" : "sounds";

  // Apply (persist + push the live side effect for) a display feature on/off.
  const applyFeature = (k: DisplayFeature, on: boolean) => {
    if (k === "bubble") {
      setShowBubble(on);
      save("show_bubble", on ? "true" : "false");
      setBubbleVisible(on).catch(console.error);
    } else {
      setPlaySounds(on);
      save("play_sounds", on ? "true" : "false");
      setEarconsEnabled(on).catch(console.error);
    }
  };

  // Turning a feature OFF asks for the "exile" confirmation; turning it back ON is
  // immediate.
  const toggleFeature = (k: DisplayFeature, currentlyOn: boolean) => {
    if (currentlyOn) {
      setExileText("");
      setPendingDisable(k);
    } else {
      applyFeature(k, true);
    }
  };

  const exileOk = exileText.trim().toLowerCase() === "exile";
  const confirmExile = () => {
    if (!exileOk || !pendingDisable) return;
    applyFeature(pendingDisable, false);
    setPendingDisable(null);
    setExileText("");
  };
  const cancelExile = () => {
    setPendingDisable(null);
    setExileText("");
  };

  const keyboardModeLabel = {
    hold: "Hold-to-talk",
    toggle: "Tap-to-toggle",
    double_tap: "Double-tap"
  }[keybindKeyboardMode] ?? "Hold-to-talk";

  return (
    <div className="page settings-page" style={{ position: "relative" }}>
      {pendingDisable && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(10, 10, 12, 0.65)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            display: "grid",
            placeItems: "center",
            zIndex: 9999,
          }}
          onClick={cancelExile}
        >
          <div
            className="glass-panel"
            style={{ width: 390, padding: 26, display: "flex", flexDirection: "column", gap: 16, border: "1px solid var(--separator-soft)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              Turn off {featureLabel(pendingDisable)}?
            </h3>
            <p style={{ margin: 0, fontSize: 13, color: "var(--secondary)", lineHeight: "19px" }}>
              This switches off a core part of LocalFlow. To confirm, type{" "}
              <strong style={{ color: "var(--label)" }}>exile</strong> below.
            </p>
            <input
              className="field"
              autoFocus
              placeholder="Type exile to confirm"
              value={exileText}
              onChange={(e) => setExileText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmExile();
                if (e.key === "Escape") cancelExile();
              }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="button" style={{ flex: 1, justifyContent: "center" }} onClick={cancelExile}>
                Cancel
              </button>
              <button
                className="button danger"
                style={{ flex: 1, justifyContent: "center" }}
                disabled={!exileOk}
                onClick={confirmExile}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
      {showBanner && (
        <div className="banner-card settings-banner" style={{ backgroundImage: "url('/redish.png')" }}>
          <div className="banner-content">
            <h2 className="banner-title">Configured for <em>your</em> workflow.</h2>
            <p className="banner-desc">
              Tune your microphone, language, privacy, and the keys that trigger dictation. Everything stays on your machine, with no account, no sync, and absolutely no one reading over your shoulder.
            </p>
            <div className="banner-actions">
              <span className="banner-tag">Privacy first</span>
              <span className="banner-tag">Lives on your disk</span>
              <span className="banner-tag">Zero telemetry</span>
            </div>
          </div>
        </div>
      )}

      <div className="page-header settings-page-header">
        <div>
          <p className="page-kicker">Preferences</p>
          <h2 className="page-title">Settings</h2>
        </div>
      </div>

      <div className="settings-bento-grid">
        <PermissionsSection />

      <Section title="Audio input" className="settings-audio">
        <SettingRow icon={Mic} label="Microphone" description="Which microphone to listen to">
          <select
            className="select"
            style={{ width: 260 }}
            value={selectedDevice}
            onChange={(e) => {
              setSelectedDevice(e.target.value);
              save("mic_device", e.target.value);
              setAudioDevice(e.target.value).catch(console.error);
            }}
          >
            {devices.length === 0 && <option value="">No devices found</option>}
            {devices.map((device) => (
              <option key={device} value={device}>
                {device}
              </option>
            ))}
          </select>
        </SettingRow>
      </Section>

      <Section title="Language" className="settings-language">
        <SettingRow icon={Globe} label="Language you speak" description="Pick 'Auto-detect' if you speak more than one language">
          <select className="select" style={{ width: 260 }} value={language} onChange={(e) => setLanguage(e.target.value)}>
            {LANGUAGES.map((item) => (
              <option key={item.code} value={item.code}>
                {item.label}
              </option>
            ))}
          </select>
        </SettingRow>
      </Section>

      <Section title="Display" className="settings-display">
        <SettingRow
          icon={MonitorCheck}
          label="Bubble size"
          description="How big the floating mic bubble is. Step it up or down until it feels right, or leave it on Auto to match your display."
        >
          <BubbleSizeStepper
            value={bubbleSize}
            onChange={(v) => {
              setBubbleSizeState(v);
              setBubbleSize(v).catch(console.error);
            }}
          />
        </SettingRow>
        <SettingRow
          icon={Circle}
          label="Bubble color"
          description="Black mic that lights up white when you talk, or the reverse. The wave matches the opposite color."
        >
          <select
            className="select"
            style={{ width: 260 }}
            value={bubbleColor}
            onChange={(e) => {
              const v = e.target.value;
              setBubbleColorState(v);
              save("bubble_color", v);
              // Tell the floating bubble window to restyle immediately.
              emit("bubble-style-changed", v).catch(console.error);
            }}
          >
            <option value="black">Black bubble, white wave</option>
            <option value="white">White bubble, black wave</option>
          </select>
        </SettingRow>
        <SettingRow
          icon={Move}
          label="Bubble position"
          description="Move the floating mic anywhere. Hold an arrow to glide it; tap the center to snap back to the default corner."
        >
          <DPad onNudge={nudgePos} onReset={resetPos} custom={bubbleCustom} />
        </SettingRow>
        <SettingRow
          icon={Eye}
          label="Show floating bubble"
          description="The little mic that floats on screen. Turn off to dictate with shortcuts only."
        >
          <Switch checked={showBubble} onChange={() => toggleFeature("bubble", showBubble)} />
        </SettingRow>
        <SettingRow
          icon={Volume2}
          label="Play sounds"
          description="Beeps when dictation starts, stops, and finishes."
        >
          <Switch checked={playSounds} onChange={() => toggleFeature("sounds", playSounds)} />
        </SettingRow>
      </Section>

      <Section title="Startup" className="settings-startup">
        <SettingRow icon={Power} label="Launch at login" description="Open LocalFlow automatically when you start your computer">
          <Switch
            checked={autostart}
            onChange={async () => {
              const next = !autostart;
              setAutostart(next);
              try {
                if (next) await enableAutostart();
                else await disableAutostart();
              } catch {
                setAutostart(!next); // revert on failure
              }
            }}
          />
        </SettingRow>
      </Section>

      <Section title="Privacy" className="settings-privacy">
        <SettingRow icon={Shield} label="Incognito mode" description="Pause saving — nothing you dictate is recorded while this is on">
          <Switch checked={privacyMode} onChange={togglePrivacy} />
        </SettingRow>
        <SettingRow icon={History} label="Save dictation history" description="Keep a list of your past dictations on this computer">
          <Switch
            checked={saveHistory}
            onChange={() => {
              const next = !saveHistory;
              setSaveHistory(next);
              save("save_history", next ? "true" : "false");
            }}
          />
        </SettingRow>
      </Section>

      <Section title="Triggers" className="settings-triggers">
        <SettingRow icon={MonitorCheck} label="Toggle dictation" description="Press once to start, press again to stop.">
          <span className="keycap">{shortcutLabel(shortcutToggle)}</span>
        </SettingRow>
        <SettingRow icon={Keyboard} label="Instant dictation" description="Hold key to talk, release key to transcribe.">
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            {shortcutLabel(keybindKeyboardName)} ({keyboardModeLabel})
          </span>
        </SettingRow>
        <SettingRow label="Mouse trigger" description="Optional mouse trigger button">
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            {keybindMouseName !== "Disabled" ? `${keybindMouseName} (${keybindMouseMode === "hold" ? "Hold-to-talk" : "Tap-to-toggle"})` : "Disabled"}
          </span>
        </SettingRow>
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--separator-soft)", display: "flex", justifyContent: "flex-end" }}>
          <Link to="/shortcuts" style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none", fontWeight: 500 }}>
            Change Shortcuts & Triggers →
          </Link>
        </div>
      </Section>

      <section className="privacy-strip settings-privacy-callout">
        <div className="privacy-strip-copy">
          <span className="privacy-strip-eyebrow">Privacy</span>
          <p className="privacy-strip-title">
            LocalFlow doesn't track you.
            <span> Your voice and text never leave this computer.</span>
          </p>
        </div>
        <div className="privacy-strip-proof">
          <span className="privacy-strip-chip">No account</span>
          <span className="privacy-strip-chip">No uploads</span>
          <span className="privacy-strip-chip">Works offline</span>
        </div>
      </section>
      </div>
    </div>
  );
}
