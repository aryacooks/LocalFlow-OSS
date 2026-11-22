import { useEffect, useState } from "react";
import { Globe, Keyboard, Mic, MonitorCheck, Shield, History, Circle, Volume2, Music, Move, Check, CircleAlert, ExternalLink, Accessibility, RotateCcw, Power, Minus, Plus, PanelTop, ClipboardCopy, Timer, AppWindow, Fingerprint, MonitorOff, Droplet, Music2, AudioLines, Speaker } from "lucide-react";
import RemoveLocalFlow from "../components/RemoveLocalFlow";
import { listAudioDevices, setAudioDevice, setSetting, getSetting, setBubbleSize, BUBBLE_SCALE_MIN, BUBBLE_SCALE_MAX, BUBBLE_SCALE_STEP, setBubbleVisible, setEarconsEnabled, setSoundSet, setBubbleMode, getBubblePlacement, setBubblePlacement, getNudgeRange, getPermissionStatus, requestAccessibilityPermission, requestMicrophonePermission, openPrivacySettings, setHistoryRetention, setHideFromCapture, historyLockSupported, unlockHistory, type PermissionStatus, type BubbleMode } from "../lib/ipc";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../lib/store";
import { toOrbVariant, type OrbVariant } from "../windows/OrbBubble";
import Dropdown from "../components/Dropdown";
import { CaptureExample, NoSaveApps } from "../components/PrivacyExtras";
import OrbStylePicker from "../components/OrbStylePicker";
import MicCheck from "../components/MicCheck";
import { Link, useLocation } from "react-router-dom";

import { langName, parseLanguages } from "../lib/languages";


function Section({
  title,
  children,
  attention,
  className,
  id,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
  /** Pulse the section gold to flag it needs the user's attention (e.g. a missing permission). */
  attention?: boolean;
  className?: string;
}) {
  return (
    <section
      id={id}
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
  stacked,
}: {
  icon?: React.ElementType;
  label: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  /** Put the control under the text, full width (for pickers that need room). */
  stacked?: boolean;
}) {
  return (
    <div className={`setting-row ${stacked ? "is-stacked" : ""}`}>
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

function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button className={`switch ${checked ? "on" : ""}`} onClick={onChange} aria-pressed={checked} disabled={disabled}>
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
      id="permissions"
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

  // "Fix it" on an error links to /settings#audio etc.: scroll there and flash it.
  const { hash } = useLocation();
  useEffect(() => {
    const id = hash.slice(1);
    if (!id) return;
    const t = setTimeout(() => {
      const el = document.getElementById(id);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.remove("settings-flash");
      void el.offsetWidth; // restart the animation
      el.classList.add("settings-flash");
    }, 120);
    return () => clearTimeout(t);
  }, [hash]);
  // Options: auto-detect among the languages chosen on the Language Model page, or
  // pin one of them. (Only the Multilingual flow model hears anything but English.)
  const [myLanguages, setMyLanguages] = useState<string[]>(["en", "hi"]);
  useEffect(() => {
    getSetting("languages").then((v) => setMyLanguages(parseLanguages(v))).catch(console.error);
  }, []);
  const languageOptions = [
    { code: "auto", label: `Auto-detect (${myLanguages.map(langName).join(" / ")})` },
    ...myLanguages.map((c) => ({ code: c, label: langName(c) })),
  ];
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
  const [showPasteCard, setShowPasteCard] = useState(true);
  const [orbOpacity, setOrbOpacity] = useState(1);
  const [pauseMedia, setPauseMedia] = useState(true);
  const [audioSource, setAudioSourceState] = useState<"mic" | "system">("mic");
  const [systemSupported, setSystemSupported] = useState(false);
  const [micCheckOpen, setMicCheckOpen] = useState(false);
  const [retention, setRetention] = useState("0");
  const [hideFromCapture, setHideFromCaptureState] = useState(false);
  const [showCaptureExample, setShowCaptureExample] = useState(false);
  const [lockSupported, setLockSupported] = useState(false);
  const [historyLock, setHistoryLock] = useState(false);
  const [isMac, setIsMac] = useState(false);

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
      const saveHist = await getSetting("save_history");
      if (saveHist) setSaveHistory(saveHist === "true");

      const bs = await getSetting("bubble_size");
      if (bs) setBubbleSizeState(bs);

      const orb = await getSetting("bubble_orb");
      const ov = toOrbVariant(orb);
      if (ov) setOrbVariant(ov);

      const pl = await getBubblePlacement().catch(() => null);
      if (pl) setOrbPlacement({ spot: pl[0], nudge: pl[1], nudgeY: pl[2] });

      setShowBubble((await getSetting("show_bubble")) !== "false");
      setPlaySounds((await getSetting("play_sounds")) !== "false");
      setShowPasteCard((await getSetting("show_paste_card")) !== "false");
      const op = Number.parseFloat((await getSetting("bubble_opacity")) ?? "1");
      setOrbOpacity(Number.isFinite(op) ? op : 1);
      setRetention((await getSetting("history_retention_days")) ?? "0");
      setPauseMedia((await getSetting("pause_media")) !== "false");
      const supported = await invoke<boolean>("system_audio_supported").catch(() => false);
      setSystemSupported(supported);
      setAudioSourceState(supported && (await getSetting("audio_source")) === "system" ? "system" : "mic");
      setHideFromCaptureState((await getSetting("hide_from_capture")) === "true");
      setLockSupported(await historyLockSupported().catch(() => false));
      setHistoryLock((await getSetting("history_lock")) === "true");
      const ss = await getSetting("sound_set");
      if (ss) setSoundSetState(ss);
      setBubbleStyleState((await getSetting("bubble_style")) === "notch" ? "notch" : "classic");
      setIsMac((await getPermissionStatus()).is_macos);
      setAutostart(await isAutostartEnabled().catch(() => false));

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


      <div className="settings-left-col">
      <Section title="Language" id="language" className="settings-language">
        <SettingRow icon={Globe} label="Language you speak" description="Pick 'Auto-detect' if you speak more than one. Add languages under Language Model.">
          <Dropdown
            ariaLabel="Language you speak"
            value={language}
            options={languageOptions.map((item) => ({ value: item.code, label: item.label }))}
            onChange={setLanguage}
          />
        </SettingRow>
      </Section>


      <Section title="Display" id="display" className="settings-display">
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
          stacked
          description={isMac
            ? "How the orb moves with your voice. It is black in light mode and white in dark mode."
            : "How the orb moves with your voice."}
        >
          <OrbStylePicker
            value={orbVariant}
            onChange={(v) => {
              setOrbVariant(v);
              save("bubble_orb", v);
              emit("bubble-orb-changed", v).catch(console.error);
            }}
          />
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
          icon={Droplet}
          label="Orb transparency"
          description="See through the orb so it gets in the way less. The menu and messages stay solid."
        >
          <div className="orb-opacity">
            <input
              type="range"
              min={20}
              max={100}
              step={5}
              value={Math.round(orbOpacity * 100)}
              aria-label="Orb opacity"
              onChange={(e) => {
                const v = Number(e.target.value) / 100;
                setOrbOpacity(v);
                save("bubble_opacity", v.toFixed(2));
                emit("bubble-opacity-changed", v).catch(console.error);
              }}
            />
            <span className="orb-opacity-value">{Math.round(orbOpacity * 100)}%</span>
          </div>
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
          icon={ClipboardCopy}
          label="Copy card"
          description="If your words can't be pasted (no text box selected), a small card pops up with them and a Copy button. Turn it off to skip it; the text is still saved in History."
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              type="button"
              className="button"
              onClick={() => invoke("preview_paste_card").catch(console.error)}
            >
              Show me
            </button>
            <Switch
              checked={showPasteCard}
              onChange={() => {
                const next = !showPasteCard;
                setShowPasteCard(next);
                save("show_paste_card", next ? "true" : "false");
              }}
            />
          </div>
        </SettingRow>
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
            <Dropdown
              ariaLabel="Sound"
              value={soundSet}
              options={[
                { value: "wood-low", label: "Wood bar, low", hint: "Default" },
                { value: "wood", label: "Wood bar" },
                { value: "wood-fifth", label: "Wood fifth" },
                { value: "bump", label: "Round bump" },
              ]}
              onChange={(v) => {
                setSoundSetState(v);
                setSoundSet(v).catch(console.error);
              }}
            />
          </SettingRow>
        )}
      </Section>
      </div>

      <div className="settings-right-col">
      <Section title="Audio input" id="audio" className="settings-audio">
        {systemSupported && (
          <SettingRow
            icon={AudioLines}
            label="Listen to"
            description={audioSource === "system"
              ? "Transcribes what your Mac is playing: videos, calls, voice notes. Your mic isn't used."
              : "Your voice through the microphone. Pick System audio to transcribe what's playing instead."}
          >
            <div className="segmented" role="radiogroup" aria-label="Listen to">
              {([["mic", "Microphone"], ["system", "System audio"]] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={audioSource === id}
                  className={`segmented-option ${audioSource === id ? "is-active" : ""}`}
                  onClick={() => {
                    setAudioSourceState(id);
                    save("audio_source", id);
                    invoke("set_audio_source", { source: id }).catch(console.error);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </SettingRow>
        )}
        {audioSource === "mic" && (
          <SettingRow icon={Mic} label="Microphone" description="Which microphone to listen to">
            <Dropdown
              ariaLabel="Microphone"
              width={220}
              value={selectedDevice}
              placeholder="No microphones found"
              options={devices.map((d) => ({ value: d, label: d }))}
              onChange={(v) => {
                setSelectedDevice(v);
                save("mic_device", v);
                setAudioDevice(v).catch(console.error);
              }}
            />
          </SettingRow>
        )}
        <SettingRow
          icon={audioSource === "system" ? Speaker : Volume2}
          label="Check audio levels"
          description={audioSource === "system" ? "Play something and see how loud it comes through." : "Talk and watch the meter, to test your mic."}
        >
          <button type="button" className="button" onClick={() => setMicCheckOpen(true)}>Check levels</button>
        </SettingRow>
        <SettingRow
          icon={Music2}
          label="Pause music while dictating"
          description={audioSource === "system"
            ? "Off while listening to system audio: that's the sound being transcribed."
            : isMac
              ? "Pauses Spotify or Music and turns everything else down while you talk, then puts it back."
              : "Mutes other sound while you talk, then turns it back on."}
        >
          <Switch
            checked={pauseMedia && audioSource !== "system"}
            disabled={audioSource === "system"}
            onChange={() => {
              const next = !pauseMedia;
              setPauseMedia(next);
              save("pause_media", next ? "true" : "false");
            }}
          />
        </SettingRow>
        <MicCheck open={micCheckOpen} source={audioSource} device={selectedDevice} onClose={() => setMicCheckOpen(false)} />
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

      <Section title="Shortcuts" className="settings-triggers">
        <SettingRow icon={Keyboard} label="Shortcuts" description="Your dictation keys, mouse button and the Fn key.">
          <Link to="/shortcuts" className="button">Open shortcuts</Link>
        </SettingRow>
      </Section>

      <Section title="Privacy" id="privacy" className="settings-privacy">
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
        <SettingRow icon={Timer} label="Auto-delete history" description="Older dictations are deleted on their own. Never keeps everything.">
          <Dropdown
            ariaLabel="Auto-delete history"
            width={160}
            value={retention}
            options={[
              { value: "0", label: "Never", hint: "Default" },
              { value: "1", label: "After 1 day" },
              { value: "7", label: "After 7 days" },
              { value: "30", label: "After 30 days" },
            ]}
            onChange={(v) => {
              setRetention(v);
              setHistoryRetention(Number(v)).catch(console.error);
            }}
          />
        </SettingRow>
        {lockSupported && (
          <SettingRow icon={Fingerprint} label="Lock History" description="Ask for Touch ID or your Mac password before showing past dictations.">
            <Switch
              checked={historyLock}
              onChange={async () => {
                const next = !historyLock;
                // Turning it off needs the same check, or anyone could switch it off.
                const ok = await unlockHistory(next ? "turn on the History lock" : "turn off the History lock").catch(() => false);
                if (!ok) return;
                setHistoryLock(next);
                save("history_lock", next ? "true" : "false");
              }}
            />
          </SettingRow>
        )}
        <SettingRow
          icon={MonitorOff}
          label="Hide from screen sharing"
          description={<>
            The orb, notch and copy card stay visible to you but don't show up for people watching your shared screen or recordings.{" "}
            <button type="button" className="inline-link" onClick={() => setShowCaptureExample((v) => !v)}>
              {showCaptureExample ? "Hide example" : "See how it looks"}
            </button>
          </>}
        >
          <Switch
            checked={hideFromCapture}
            onChange={() => {
              const next = !hideFromCapture;
              setHideFromCaptureState(next);
              setHideFromCapture(next).catch(console.error);
            }}
          />
        </SettingRow>
        {showCaptureExample && <CaptureExample />}
        <SettingRow
          icon={AppWindow}
          label="Don't save from these apps"
          description="Dictation still works in these apps, but nothing you say there is kept in History. Good for password managers, banking and private chats."
          stacked
        >
          <NoSaveApps />
        </SettingRow>
      </Section>




      </div>

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

      <div className="settings-remove">
        <RemoveLocalFlow />
      </div>
      </div>
    </div>
  );
}
