import { useEffect, useState } from "react";
import { Globe, Keyboard, Mic, MonitorCheck, Shield, History, Circle, Volume2, Music, Move, Check, CircleAlert, ExternalLink, Accessibility, RotateCcw, Power, Minus, Plus, PanelTop } from "lucide-react";
import { listAudioDevices, setAudioDevice, setSetting, getSetting, setBubbleSize, BUBBLE_SCALE_MIN, BUBBLE_SCALE_MAX, BUBBLE_SCALE_STEP, setBubbleVisible, setEarconsEnabled, setSoundSet, setBubbleMode, getBubblePlacement, setBubblePlacement, getNudgeRange, getPermissionStatus, requestAccessibilityPermission, requestMicrophonePermission, openPrivacySettings, type PermissionStatus, type BubbleMode } from "../lib/ipc";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { shortcutLabel } from "../lib/utils";
import { emit, listen } from "@tauri-apps/api/event";
import { useAppStore } from "../lib/store";
import { ORB_VARIANTS, type OrbVariant } from "../windows/OrbBubble";
import { Link } from "react-router-dom";
import { reloadGlobalShortcut, requestInputMonitoringPermission } from "../lib/ipc";

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

// Pick one of 8 spots on a mini screen, then shift left/right with the slider.
// (Dragging the orb itself on screen does the same and snaps to the nearest spot.)
const ORB_SPOTS: { id: string; x: number; y: number; label: string }[] = [
  { id: "tl", x: 0, y: 0, label: "Top left" },
  { id: "tc", x: 0.5, y: 0, label: "Top centre (by the notch)" },
  { id: "tr", x: 1, y: 0, label: "Top right" },
  { id: "ml", x: 0, y: 0.5, label: "Left edge" },
  { id: "mr", x: 1, y: 0.5, label: "Right edge" },
  { id: "bl", x: 0, y: 1, label: "Bottom left" },
  { id: "bc", x: 0.5, y: 1, label: "Bottom centre" },
  { id: "br", x: 1, y: 1, label: "Bottom right" },
];
// Fallback slider limits until the real ones (from the screen size) arrive.
const NUDGE_FALLBACK: [number, number, number, number, number, number] = [-300, 300, -300, 300, 1440, 900];

function OrbPlacer({
  spot,
  nudge,
  nudgeY,
  onChange,
}: {
  spot: string;
  nudge: number;
  nudgeY: number;
  onChange: (spot: string, nudge: number, nudgeY: number) => void;
}) {
  const W = 176, H = 110, PAD = 11;
  // How far the orb can actually go from this spot before it hits a screen edge.
  const [range, setRange] = useState(NUDGE_FALLBACK);
  useEffect(() => {
    let live = true;
    getNudgeRange(spot).then((r) => { if (live && r) setRange(r); }).catch(() => {});
    return () => { live = false; };
  }, [spot]);
  const [minX, maxX, minY, maxY, screenW, screenH] = range;
  const slider = (
    label: [string, string],
    value: number,
    lo: number,
    hi: number,
    set: (v: number) => void,
    title: string,
  ) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, width: W + 64 }}>
      <span style={{ width: 30, fontSize: 10, fontWeight: 600, color: "var(--tertiary)", textAlign: "right" }}>{label[0]}</span>
      <input
        type="range"
        min={lo}
        max={hi}
        step={1}
        value={Math.min(Math.max(value, lo), hi)}
        onChange={(e) => set(Number(e.target.value))}
        title={title}
        style={{ flex: 1, accentColor: "var(--label)" }}
      />
      <span style={{ width: 30, fontSize: 10, fontWeight: 600, color: "var(--tertiary)" }}>{label[1]}</span>
      <button
        type="button"
        onClick={() => set(0)}
        disabled={value === 0}
        title="Back to the centre of the spot"
        style={{
          fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 999,
          border: "1.5px solid var(--separator)", background: "transparent",
          color: value === 0 ? "var(--tertiary)" : "var(--label)",
          cursor: value === 0 ? "default" : "pointer", opacity: value === 0 ? 0.6 : 1,
        }}
      >
        Center
      </button>
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <div
        style={{
          position: "relative", width: W, height: H, borderRadius: 10,
          border: "1.5px solid var(--separator)", background: "var(--separator-soft)",
        }}
      >
        {ORB_SPOTS.map((p) => {
          const on = p.id === spot;
          const cx = PAD + p.x * (W - 2 * PAD) + (on ? (nudge / screenW) * (W - 2 * PAD) : 0);
          const cy = PAD + p.y * (H - 2 * PAD) + (on ? (nudgeY / screenH) * (H - 2 * PAD) : 0);
          return (
            <button
              key={p.id}
              type="button"
              title={p.label}
              aria-label={p.label}
              aria-pressed={on}
              onClick={() => onChange(p.id, 0, 0)}
              style={{
                position: "absolute",
                left: Math.min(Math.max(cx, 2), W - 2) - 9, top: Math.min(Math.max(cy, 2), H - 2) - 9,
                width: 18, height: 18, borderRadius: "50%", padding: 0, cursor: "pointer",
                border: on ? "none" : "1.5px dashed var(--tertiary)",
                background: on ? "var(--label)" : "transparent",
                boxShadow: on ? "0 1px 4px rgba(0,0,0,.25)" : "none",
                transition: "left 120ms ease, top 120ms ease",
              }}
            />
          );
        })}
      </div>
      {slider(["Left", "Right"], nudge, minX, maxX, (v) => onChange(spot, v, nudgeY), "Shift left or right")}
      {slider(["Up", "Down"], nudgeY, minY, maxY, (v) => onChange(spot, nudge, v), "Shift up or down")}
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
  const [orbVariant, setOrbVariant] = useState<OrbVariant>("blob");
  // Whether the floating bubble has been moved off its default bottom-right spot.
  const [orbPlacement, setOrbPlacement] = useState({ spot: "br", nudge: 0, nudgeY: 0 });
  const [showBubble, setShowBubble] = useState(true);
  const [playSounds, setPlaySounds] = useState(true);
  const [soundSet, setSoundSetState] = useState("wood-low");
  const [bubbleStyle, setBubbleStyleState] = useState<"classic" | "notch">("classic");
  const [autostart, setAutostart] = useState(false);
  const [fnEnabled, setFnEnabled] = useState(false);
  const [isMac, setIsMac] = useState(false);
  
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

      const orb = await getSetting("bubble_orb");
      if (orb && ORB_VARIANTS.some((v) => v.id === orb)) setOrbVariant(orb as OrbVariant);

      const pl = await getBubblePlacement().catch(() => null);
      if (pl) setOrbPlacement({ spot: pl[0], nudge: pl[1], nudgeY: pl[2] });

      setShowBubble((await getSetting("show_bubble")) !== "false");
      setPlaySounds((await getSetting("play_sounds")) !== "false");
      const ss = await getSetting("sound_set");
      if (ss) setSoundSetState(ss);
      setBubbleStyleState((await getSetting("bubble_style")) === "notch" ? "notch" : "classic");
      setFnEnabled((await getSetting("fn_quick_toggle")) === "true");
      setIsMac((await getPermissionStatus()).is_macos);
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

  useEffect(() => {
    const un = listen<{ bubble?: boolean; sounds?: boolean }>("display-settings-changed", ({ payload }) => {
      if (payload.bubble !== undefined) setShowBubble(payload.bubble);
      if (payload.sounds !== undefined) setPlaySounds(payload.sounds);
    });
    return () => { un.then((f) => f()); };
  }, []);

  const save = async (key: string, value: string) => setSetting(key, value).catch(console.error);

  const placeOrb = (spot: string, nudge: number, nudgeY: number) => {
    setOrbPlacement({ spot, nudge, nudgeY });
    setBubblePlacement(spot, nudge, nudgeY).catch(console.error);
  };

  // Follow drags / placement-mode picks made on the orb itself.
  useEffect(() => {
    const un = listen<{ spot: string; nudge: number; nudge_y: number }>("bubble-placement-changed", ({ payload }) =>
      setOrbPlacement({ spot: payload.spot, nudge: payload.nudge ?? 0, nudgeY: payload.nudge_y ?? 0 }));
    return () => { un.then((f) => f()); };
  }, []);

  type DisplayFeature = "bubble" | "sounds";

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

  const toggleFeature = (k: DisplayFeature, currentlyOn: boolean) => {
    applyFeature(k, !currentlyOn);
  };

  const keyboardModeLabel = {
    hold: "Hold-to-talk",
    toggle: "Tap-to-toggle",
    double_tap: "Double-tap"
  }[keybindKeyboardMode] ?? "Hold-to-talk";

  return (
    <div className="page settings-page" style={{ position: "relative" }}>

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
          icon={PanelTop}
          label="Animation"
          description={isMac
            ? "What shows while you dictate: a small orb on screen, an island that grows out of the notch, or nothing at all."
            : "What shows while you dictate: a small orb on screen, or nothing at all."}
        >
          {(() => {
            const mode = !showBubble ? "off" : bubbleStyle === "notch" && isMac ? "notch" : "screen";
            const options: { id: BubbleMode; label: string }[] = [
              { id: "screen" as BubbleMode, label: "On screen" },
              ...(isMac ? [{ id: "notch" as BubbleMode, label: "Notch" }] : []),
              { id: "off" as BubbleMode, label: "Off" },
            ];
            return (
              <div className="segmented segmented-lg" role="radiogroup" aria-label="Animation">
                {options.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    role="radio"
                    aria-checked={mode === o.id}
                    className={`segmented-option ${mode === o.id ? "is-active" : ""}`}
                    onClick={() => {
                      const v = o.id;
                      setShowBubble(v !== "off");
                      if (v !== "off") setBubbleStyleState(v === "notch" ? "notch" : "classic");
                      setBubbleMode(v).catch(console.error);
                    }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            );
          })()}
        </SettingRow>
        {showBubble && (bubbleStyle === "classic" || !isMac) && (<>
        <SettingRow
          icon={Circle}
          label="Orb style"
          description={isMac
            ? "How the orb moves with your voice. It turns black over light windows and white over dark ones, which needs Screen Recording permission (nothing is saved)."
            : "How the orb moves with your voice."}
        >
          <select
            className="select"
            style={{ width: 260 }}
            value={orbVariant}
            onChange={(e) => {
              const v = e.target.value as OrbVariant;
              setOrbVariant(v);
              save("bubble_orb", v);
              emit("bubble-orb-changed", v).catch(console.error);
            }}
          >
            {ORB_VARIANTS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </SettingRow>
        <SettingRow
          icon={MonitorCheck}
          label="Orb size"
          description="Step it up or down until it feels right, or leave it on Auto to match your display."
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
          icon={Move}
          label="Orb position"
          description="Drag the orb on screen and drop it near any of these spots, or pick one here. The sliders fine-tune it left/right and up/down."
        >
          <OrbPlacer spot={orbPlacement.spot} nudge={orbPlacement.nudge} nudgeY={orbPlacement.nudgeY} onChange={placeOrb} />
        </SettingRow>
        </>)}
        <SettingRow
          icon={Volume2}
          label="Play sounds"
          description="A soft tap when dictation starts and stops."
        >
          <Switch checked={playSounds} onChange={() => toggleFeature("sounds", playSounds)} />
        </SettingRow>
        {playSounds && (
          <SettingRow
            icon={Music}
            label="Sound"
            description="Pick one to hear its start sound."
          >
            <select
              className="select"
              style={{ width: 260 }}
              value={soundSet}
              onChange={(e) => {
                const v = e.target.value;
                setSoundSetState(v);
                setSoundSet(v).catch(console.error);
              }}
            >
              <option value="wood-low">Wood bar, low (default)</option>
              <option value="wood">Wood bar</option>
              <option value="wood-fifth">Wood fifth</option>
              <option value="bump">Round bump</option>
            </select>
          </SettingRow>
        )}
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
        {isMac && (
          <SettingRow icon={Keyboard} label="Fn quick toggle" description="Hold Fn to talk. Double-tap to keep recording; press Fn again to finish.">
            <Switch checked={fnEnabled} onChange={async () => {
              const next = !fnEnabled;
              try {
                await setSetting("fn_quick_toggle", String(next));
                await reloadGlobalShortcut();
                setFnEnabled(next);
                if (next) await requestInputMonitoringPermission();
              } catch (error) { console.error(error); }
            }} />
          </SettingRow>
        )}
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
