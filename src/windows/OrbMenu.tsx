import { forwardRef, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { EyeOff, PanelLeft, Power, VenetianMask, Volume2, VolumeX } from "lucide-react";
import oilTex from "../assets/oil/impasto.svg";

/**
 * OrbMenu — the orb's right-click menu. Follows the main window's look like the
 * paste card does: in the Oil look it's a small painted card (cream paper by day,
 * dusk violet at night) with an ink rule, Mona Sans labels and mono state tags.
 */

interface Palette {
  oil: boolean;
  card: string; ink: string; muted: string; rule: string; border: string; shadow: string;
  hover: string; dot: string; on: string; onText: string; offBorder: string;
  danger: string; dangerHover: string; radius: number; font: string; mono: string;
}

const MONO = "'Martian Mono', ui-monospace, monospace";

function readPalette(): Palette {
  let dark = false, oil = false;
  try {
    dark = localStorage.getItem("localflow-theme") === "dark";
    oil = true; // oil is the only look
  } catch { /* defaults */ }
  if (oil && !dark) return {
    oil, card: "#fbf6ec", ink: "#16130f", muted: "rgba(22,19,15,0.55)", rule: "rgba(22,19,15,0.14)",
    border: "1px solid #16130f", shadow: "0 1px 0 rgba(22,19,15,0.08), 0 16px 30px -12px rgba(110,50,15,0.6)",
    hover: "#f3e3bd", dot: "#2f6b3c", on: "#073929", onText: "#f1ece2", offBorder: "rgba(22,19,15,0.35)",
    danger: "#a93226", dangerHover: "rgba(169,50,38,0.1)", radius: 7,
    font: "'Mona Sans', -apple-system, sans-serif", mono: MONO,
  };
  if (oil && dark) return {
    oil, card: "#2b2847", ink: "#f1ece2", muted: "rgba(241,236,226,0.6)", rule: "rgba(241,236,226,0.14)",
    border: "1px solid rgba(241,236,226,0.32)", shadow: "0 1px 0 rgba(0,0,0,0.25), 0 18px 34px -12px rgba(5,4,20,0.9)",
    hover: "rgba(241,236,226,0.09)", dot: "#fbb927", on: "#fbb927", onText: "#16130f", offBorder: "rgba(241,236,226,0.35)",
    danger: "#ff9d8a", dangerHover: "rgba(255,120,100,0.12)", radius: 7,
    font: "'Mona Sans', -apple-system, sans-serif", mono: MONO,
  };
  // The regular look keeps its dark glass menu.
  return {
    oil, card: "rgba(24,24,27,0.97)", ink: "#e4e4e7", muted: "rgba(228,228,231,0.55)", rule: "rgba(255,255,255,0.07)",
    border: "1px solid rgba(255,255,255,0.1)", shadow: "0 8px 24px rgba(0,0,0,0.6)",
    hover: "rgba(255,255,255,0.08)", dot: "#4ade80", on: "#a78bfa", onText: "#18181b", offBorder: "rgba(255,255,255,0.25)",
    danger: "#fca5a5", dangerHover: "rgba(239,68,68,0.12)", radius: 9,
    font: "'Inter', -apple-system, sans-serif", mono: "ui-monospace, 'SF Mono', monospace",
  };
}

interface Props {
  style: CSSProperties;
  /** Same scale the orb uses, so the menu grows with it. */
  scale: number;
  privacy: boolean;
  sounds: boolean;
  onPrivacy: () => void;
  onSounds: () => void;
  onHide: () => void;
  onOpenApp: () => void;
  onQuit: () => void;
}

const OrbMenu = forwardRef<HTMLDivElement, Props>(function OrbMenu(
  { style, scale, privacy, sounds, onPrivacy, onSounds, onHide, onOpenApp, onQuit },
  ref,
) {
  const [p, setP] = useState(readPalette);
  // Theme changes in the main window land here through localStorage.
  useEffect(() => {
    const onStorage = () => setP(readPalette());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const s = (v: number) => `${v * scale}px`;
  const icon = 14 * scale;

  const tag = (on: boolean, label: string): ReactNode => (
    <span
      className="om-tag"
      style={{
        fontFamily: p.mono,
        fontSize: s(8.5),
        letterSpacing: "0.08em",
        padding: `${s(2)} ${s(6)}`,
        borderRadius: 999,
        background: on ? p.on : "transparent",
        color: on ? p.onText : p.muted,
        border: `1px solid ${on ? p.on : p.offBorder}`,
        lineHeight: 1.3,
      }}
    >
      {label}
    </span>
  );

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="LocalFlow"
      className={`orb-menu ${p.oil ? "is-oil" : ""}`}
      style={{
        ...style,
        width: s(168),
        boxSizing: "border-box",
        padding: s(5),
        borderRadius: s(p.radius),
        background: p.oil ? `url("${oilTex}") 0 0 / 300px 300px, ${p.card}` : p.card,
        backgroundBlendMode: p.oil ? "soft-light, normal" : undefined,
        border: p.border,
        boxShadow: p.shadow,
        backdropFilter: p.oil ? undefined : "blur(12px)",
        color: p.ink,
        fontFamily: p.font,
        pointerEvents: "auto",
        zIndex: 50,
        animation: "orbMenuIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      {/* Header: the wordmark, and a reminder that it all stays on this machine. */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: `${s(5)} ${s(8)} ${s(6)}` }}>
        <span style={{ fontFamily: "'Inter Variable', 'Inter', sans-serif", fontWeight: 700, letterSpacing: "-0.02em", fontSize: s(12.5) }}>
          LocalFlow
        </span>
        <span style={{ fontFamily: p.mono, fontSize: s(8), letterSpacing: "0.08em", color: p.muted, textTransform: "uppercase", display: "inline-flex", alignItems: "center", gap: s(4) }}>
          <i style={{ width: s(5), height: s(5), borderRadius: "50%", background: p.dot, display: "inline-block" }} />
          on device
        </span>
      </div>
      <div className="om-rule" />

      <button role="menuitemcheckbox" aria-checked={privacy} className="om-item" onClick={onPrivacy}>
        <VenetianMask size={icon} />
        <span className="om-label">Incognito</span>
        {tag(privacy, privacy ? "ON" : "OFF")}
      </button>
      <button role="menuitemcheckbox" aria-checked={sounds} className="om-item" onClick={onSounds}>
        {sounds ? <Volume2 size={icon} /> : <VolumeX size={icon} />}
        <span className="om-label">Sounds</span>
        {tag(sounds, sounds ? "ON" : "MUTED")}
      </button>
      <button role="menuitem" className="om-item" onClick={onHide}>
        <EyeOff size={icon} />
        <span className="om-label">Hide bubble</span>
      </button>

      <div className="om-rule" />
      <button role="menuitem" className="om-item" onClick={onOpenApp}>
        <PanelLeft size={icon} />
        <span className="om-label">Open LocalFlow</span>
      </button>
      <button role="menuitem" className="om-item om-danger" onClick={onQuit}>
        <Power size={icon} />
        <span className="om-label">Quit</span>
      </button>

      <style>{`
        .orb-menu .om-item {
          display: flex; align-items: center; gap: ${s(9)}; width: 100%;
          padding: ${s(6.5)} ${s(8)}; margin: 0; background: transparent; border: none;
          border-radius: ${s(Math.max(p.radius - 2, 4))}; color: inherit; font: inherit;
          font-size: ${s(12.5)}; font-weight: ${p.oil ? 600 : 500}; cursor: pointer; text-align: left;
          transition: background 0.12s;
        }
        .orb-menu .om-item svg { flex-shrink: 0; opacity: 0.85; }
        .orb-menu .om-label { flex: 1; white-space: nowrap; }
        .orb-menu .om-item:hover, .orb-menu .om-item:focus-visible { background: ${p.hover}; outline: none; }
        .orb-menu .om-danger { color: ${p.danger}; }
        .orb-menu .om-danger:hover, .orb-menu .om-danger:focus-visible { background: ${p.dangerHover}; }
        .orb-menu .om-rule { height: 1px; background: ${p.rule}; margin: ${s(4)} ${s(6)}; }
        @keyframes orbMenuIn {
          from { opacity: 0; translate: 0 4px; scale: 0.96; }
          to { opacity: 1; translate: 0 0; scale: 1; }
        }
      `}</style>
    </div>
  );
});

export default OrbMenu;
