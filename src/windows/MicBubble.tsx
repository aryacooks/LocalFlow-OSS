import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getSetting } from "../lib/ipc";

import logoIcon from "../assets/brand/logo_icon.png";
import logoWhite from "../assets/brand/logo_white.png";

// Manual screen-size override → bubble scale. MUST stay in sync with the Rust
// `screen_size_to_scale` in lib.rs (window size there, content size here). Returns
// null for "auto"/unknown so we fall back to the geometry-based heuristic.
function screenSizeToScale(size: string | null): number | null {
  switch (size) {
    case "13": return 1.0;
    case "14": return 1.1;
    case "15": return 1.2;
    case "16": return 1.3;
    case "17": return 1.38;
    default: return null;
  }
}

/**
 * MicBubble — Borderless, backgroundless floating widget.
 * Coordinates are mapped within a static 240x40 transparent Tauri window.
 *
 * Idle  → Logo sits at the right side (centered in a virtual 40x40 area).
 * Active → Logo slides smoothly to the left (128px from the right),
 *          and the live voice frequency meter fades in exactly where the logo was.
 * Done  → Logo slides further to the left (208px from the right),
 *          and the transcribed text fades in next to it.
 */
export default function MicBubble() {
  const [status, setStatus] = useState<"idle" | "recording" | "processing" | "command" | "done">("idle");
  const [bars, setBars] = useState<number[]>(Array(8).fill(0.1));
  const [transcribedText, setTranscribedText] = useState("");
  const [isError, setIsError] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [logoHovered, setLogoHovered] = useState(false);
  const [uiScale, setUiScale] = useState(1);
  // "white" (default): white idle logo, black logo + black wave when active.
  // "black": the reverse — black idle logo, white logo + white wave when active.
  const [bubbleColor, setBubbleColor] = useState<"black" | "white">("white");
  const [privacy, setPrivacy] = useState(false);
  const ampRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const logoRef = useRef<HTMLDivElement | null>(null);

  /* ── Lifecycle & Listeners ──────────────────────────────────── */
  useEffect(() => {
    document.body.style.background = "transparent";
    document.body.style.overflow   = "hidden";
    document.body.style.margin     = "0";

    const checkInitial = async () => {
      try {
        const isRec = await invoke<boolean>("is_recording");
        if (isRec) setStatus("recording");
      } catch { /* ignore */ }
    };
    checkInitial();

    return () => { document.body.style.background = ""; };
  }, []);

  // Load the saved bubble color and keep it in sync with the Settings page (which
  // broadcasts "bubble-style-changed" when the user flips it).
  useEffect(() => {
    invoke<string | null>("get_setting", { key: "bubble_color" })
      .then((v) => { if (v === "white" || v === "black") setBubbleColor(v); })
      .catch(() => {});
    const un = listen<string>("bubble-style-changed", (e) => {
      const v = e.payload;
      if (v === "white" || v === "black") setBubbleColor(v);
    });
    return () => { un.then((f) => f()); };
  }, []);

  // Mirror incognito (privacy) mode, kept in sync with the sidebar/tray.
  useEffect(() => {
    invoke<boolean>("get_privacy_mode").then(setPrivacy).catch(() => {});
    const un = listen<boolean>("privacy-changed", (e) => setPrivacy(e.payload));
    return () => { un.then((f) => f()); };
  }, []);

  useEffect(() => {
    // Derive the UI scale from the display size (mirrors the Rust `bubble_scale`),
    // not the window width — the window now resizes per state, so keying off
    // innerWidth would make the logo jump sizes between states. A manual screen-size
    // override (Settings → Display) wins over the auto heuristic.
    const updateScale = async () => {
      let override: number | null = null;
      try {
        override = screenSizeToScale(await getSetting("screen_size"));
      } catch { /* ignore — fall back to auto */ }
      if (override != null) {
        setUiScale(override);
        return;
      }
      const shortest = Math.min(window.screen.width, window.screen.height);
      setUiScale(Math.min(Math.max(shortest / 900, 1), 1.38));
    };
    updateScale();
    const onResize = () => { updateScale(); };
    window.addEventListener("resize", onResize);
    // Settings changes the override on the main window; re-read when it tells us to.
    const unlisten = listen("screen-size-changed", () => { updateScale(); });
    return () => {
      window.removeEventListener("resize", onResize);
      unlisten.then((f) => f());
    };
  }, []);

  // Keep the OS window tightly sized to whatever is actually visible, so the empty
  // space around the logo no longer intercepts clicks. Right-anchored in Rust, so
  // the logo stays put while only the left edge moves.
  useEffect(() => {
    let width: number;
    let height: number;
    if (menuOpen) {
      width = 180; height = 188;
    } else if (status === "recording" || status === "processing" || status === "command") {
      width = 180; height = 60;
    } else if (status === "done") {
      width = 240; height = isError ? 110 : 60;
    } else {
      width = 44; height = 44; // idle: hug the logo tightly so clicks pass through nearby
    }
    invoke("resize_bubble", { width, height }).catch(() => {});
  }, [status, menuOpen, isError, uiScale]);

  // Done auto-collapse sequence
  useEffect(() => {
    if (status === "done") {
      const id = setTimeout(() => {
        setStatus("idle");
        setTranscribedText("");
        setIsError(false);
      }, 2500);
      return () => clearTimeout(id);
    }
  }, [status]);

  // Audio level polling & state listeners
  useEffect(() => {
    ampRef.current = setInterval(async () => {
      try {
        const a = await invoke<{ rms: number; bars: number[] }>("get_amplitude");
        if (a?.bars?.length) {
          setBars(a.bars.slice(0, 8));
        } else {
          setBars(Array(8).fill(0).map(() => 0.05 + Math.random() * 0.1));
        }
      } catch {
        setBars(Array(8).fill(0).map(() => 0.05 + Math.random() * 0.1));
      }
    }, 100);

    const u1 = listen("recording-started", () => {
      setTranscribedText("");
      setIsError(false);
      setStatus("recording");
    });
    const u2 = listen("processing-started", () => setStatus("processing"));
    const u3 = listen("command-mode-started", () => {
      setTranscribedText("");
      setIsError(false);
      setStatus("command");
    });
    const u4 = listen<{ raw?: string; cleaned?: string; error?: string }>("processing-done", (ev) => {
      const p = ev.payload;
      if (p.error) {
        setTranscribedText(p.error === "Cancelled" ? "Cancelled" : `Error: ${p.error}`);
        setIsError(p.error !== "Cancelled");
      } else if (p.cleaned) {
        setTranscribedText(p.cleaned);
        setIsError(false);
      } else {
        setTranscribedText("");
        setIsError(false);
      }
      setStatus("done");
    });

    return () => {
      if (ampRef.current) clearInterval(ampRef.current);
      u1.then(f => f());
      u2.then(f => f());
      u3.then(f => f());
      u4.then(f => f());
    };
  }, []);

  /* ── Actions ────────────────────────────────────────────────── */
  const handleClick = async () => {
    if (menuOpen) return; // Don't trigger recording when menu is open
    if (status === "idle") {
      await invoke("start_recording_cmd").catch(console.error);
    } else if (status === "recording" || status === "command") {
      await invoke("stop_and_transcribe_cmd").catch(console.error);
    }
  };

  const handleRightClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Don't open menu during any active recording/processing state
    if (status !== "idle" && status !== "done") return;
    // The resize effect (keyed on menuOpen) grows/shrinks the window to fit the menu.
    setMenuOpen((open) => !open);
  };

  // Auto-close menu if recording starts while menu is open (e.g. triggered by hotkey)
  useEffect(() => {
    if (menuOpen && status !== "idle" && status !== "done") {
      setMenuOpen(false);
    }
  }, [status, menuOpen]);

  // Close menu when clicking outside
  useEffect(() => {
    if (!menuOpen) return;
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current && !menuRef.current.contains(target) &&
        logoRef.current && !logoRef.current.contains(target)
      ) {
        setMenuOpen(false);
      }
    };
    // Delay listener so the right-click itself doesn't immediately close it
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleOutsideClick);
    }, 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [menuOpen]);

  const isActive = status !== "idle";

  // Compute absolute positioning right offsets
  const logoRight =
    status === "done" ? 208
    : (status === "recording" || status === "processing" || status === "command") ? 128
    : 8; // idle centered position inside 40px bounding box

  const s = (value: number) => `${value * uiScale}px`;

  // The active accent (wave + active logo + status text) is the OPPOSITE of the
  // chosen idle bubble color, so the two states always contrast.
  const baseIsBlack = bubbleColor !== "white";
  const idleLogo = baseIsBlack ? logoIcon : logoWhite;
  const activeLogo = baseIsBlack ? logoWhite : logoIcon;
  const waveGradient = baseIsBlack
    ? "linear-gradient(180deg,#ffffff,#d4d4d8)"
    : "linear-gradient(180deg,#18181b,#3f3f46)";
  const doneTextColor = baseIsBlack ? "#e4e4e7" : "#27272a";
  const processingTextColor = baseIsBlack ? "rgba(255, 255, 255, 0.85)" : "rgba(0, 0, 0, 0.82)";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "transparent",
        userSelect: "none",
        fontFamily: "'Inter', -apple-system, sans-serif",
        overflow: "visible",
        pointerEvents: "none",
      }}
    >
      {/* ─── Floating Logo ─── */}
      <div
        ref={logoRef}
        onClick={handleClick}
        onContextMenu={handleRightClick}
        onMouseEnter={() => setLogoHovered(true)}
        onMouseLeave={() => setLogoHovered(false)}
        style={{
          position: "absolute",
          right: s(logoRight),
          bottom: s(8),
          width: s(24),
          height: s(24),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "right 0.35s cubic-bezier(0.16, 1, 0.3, 1), transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
          // Hover grows the logo by 100% (2×); menu-open keeps the subtler 1.2× cue.
          transform: logoHovered ? "scale(1.4)" : menuOpen ? "scale(1.2)" : "scale(1)",
          // Grow toward the empty space (left) so the enlarged logo isn't clipped
          // against the small bubble window's right edge.
          transformOrigin: "right center",
          filter: "drop-shadow(0px 2px 4px rgba(0, 0, 0, 0.55))",
          pointerEvents: "auto",
          cursor: "pointer",
        }}
      >
        <img
          src={isActive ? activeLogo : idleLogo}
          alt="LocalFlow"
          style={{
            height: s(20),
            width: s(20),
            objectFit: "contain",
          }}
        />
      </div>

      {/* ─── Right-Click Context Menu ─── */}
      {/* Rendered at the TOP of the window (top:0), only visible when window is expanded */}
      {menuOpen && (
        <div
          ref={menuRef}
          style={{
            position: "absolute",
            right: s(8),
            top: s(8),
            minWidth: s(136),
            background: "rgba(24, 24, 27, 0.97)",
            border: "1px solid rgba(255, 255, 255, 0.1)",
            borderRadius: s(8),
            padding: s(4),
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255,255,255,0.05)",
            backdropFilter: "blur(12px)",
            pointerEvents: "auto",
            zIndex: 50,
            animation: "menuFadeIn 0.18s cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        >
          <button
            onClick={async (e) => {
              e.stopPropagation();
              const v = await invoke<boolean>("toggle_privacy_mode").catch(() => null);
              if (v !== null) setPrivacy(v);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: s(8),
              width: "100%",
              padding: `${s(7)} ${s(10)}`,
              background: privacy ? "rgba(167,139,250,0.12)" : "transparent",
              border: "none",
              borderRadius: s(5),
              color: privacy ? "#c4b5fd" : "#e4e4e7",
              fontSize: s(12),
              fontWeight: 500,
              fontFamily: "inherit",
              cursor: "pointer",
              textAlign: "left",
              transition: "background 0.12s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = privacy ? "rgba(167,139,250,0.2)" : "rgba(255,255,255,0.08)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = privacy ? "rgba(167,139,250,0.12)" : "transparent")}
          >
            <svg width={14 * uiScale} height={14 * uiScale} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
              <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1 -1.67 2.68" />
              <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39 -1.61" />
              <line x1="2" y1="2" x2="22" y2="22" />
            </svg>
            <span style={{ flex: 1 }}>Incognito</span>
            <span style={{ fontSize: s(10), opacity: 0.85 }}>{privacy ? "On" : "Off"}</span>
          </button>
          <div style={{ height: "1px", background: "rgba(255,255,255,0.06)", margin: `${s(2)} ${s(6)}` }} />
          <button
            onClick={async () => {
              setMenuOpen(false);
              await invoke("open_main_window").catch(console.error);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: s(8),
              width: "100%",
              padding: `${s(7)} ${s(10)}`,
              background: "transparent",
              border: "none",
              borderRadius: s(5),
              color: "#e4e4e7",
              fontSize: s(12),
              fontWeight: 500,
              fontFamily: "inherit",
              cursor: "pointer",
              textAlign: "left",
              transition: "background 0.12s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <svg width={14 * uiScale} height={14 * uiScale} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
            Open App
          </button>
          <div style={{ height: "1px", background: "rgba(255,255,255,0.06)", margin: `${s(2)} ${s(6)}` }} />
          <button
            onClick={async () => {
              await invoke("quit_app").catch(console.error);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: s(8),
              width: "100%",
              padding: `${s(7)} ${s(10)}`,
              background: "transparent",
              border: "none",
              borderRadius: s(5),
              color: "#fca5a5",
              fontSize: s(12),
              fontWeight: 500,
              fontFamily: "inherit",
              cursor: "pointer",
              textAlign: "left",
              transition: "background 0.12s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(239,68,68,0.12)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <svg width={14 * uiScale} height={14 * uiScale} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
            Quit App
          </button>
        </div>
      )}

      {/* ─── Voice Frequency Meter (Speech Waveform) ─── */}
      <div
        onClick={handleClick}
        style={{
          position: "absolute",
          right: s(8),
          bottom: s(10),
          width: s(112),
          height: s(20),
          display: "flex",
          alignItems: "center",
          gap: s(2.5),
          opacity: (status === "recording" || status === "command") ? 1 : 0,
          pointerEvents: (status === "recording" || status === "command") ? "auto" : "none",
          transition: "opacity 0.25s ease-in-out",
          filter: "drop-shadow(0px 2px 4px rgba(0, 0, 0, 0.55))",
          cursor: "pointer",
        }}
      >
        {bars.map((amp, i) => {
          const h = Math.max(3, amp * 18) * uiScale;
          return (
            <div
              key={i}
              style={{
                flex: 1,
                height: `${h}px`,
                borderRadius: s(1),
                background: status === "command"
                  ? "linear-gradient(180deg,#c084fc,#a78bfa)"
                  : waveGradient,
                transition: "height 80ms ease-out",
              }}
            />
          );
        })}
      </div>

      {/* ─── Processing Text ─── */}
      <div
        onClick={handleClick}
        style={{
          position: "absolute",
          right: s(8),
          bottom: s(10),
          width: s(112),
          height: s(20),
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          opacity: status === "processing" ? 1 : 0,
          pointerEvents: status === "processing" ? "auto" : "none",
          transition: "opacity 0.25s ease-in-out",
          filter: "drop-shadow(0px 2px 4px rgba(0, 0, 0, 0.55))",
          cursor: "pointer",
        }}
      >
        <span style={{
          color: processingTextColor,
          fontSize: s(11),
          fontWeight: 600,
          animation: "shimmer 1.2s infinite alternate",
          whiteSpace: "nowrap",
        }}>
          Processing...
        </span>
      </div>

      {/* ─── Transcription Text (Done State - Success Only) ─── */}
      <div
        onClick={handleClick}
        style={{
          position: "absolute",
          right: s(8),
          bottom: s(10),
          width: s(192),
          height: s(20),
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          opacity: (status === "done" && !isError) ? 1 : 0,
          pointerEvents: (status === "done" && !isError) ? "auto" : "none",
          transition: "opacity 0.25s ease-in-out",
          filter: "drop-shadow(0px 2px 4px rgba(0, 0, 0, 0.55))",
          cursor: "pointer",
        }}
      >
        <span style={{
          color: doneTextColor,
          fontSize: s(11),
          fontWeight: 500,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          width: "100%",
        }}>
          {`"${transcribedText}"`}
        </span>
      </div>

      {/* ─── Full Error Message Callout (Displayed on Top) ─── */}
      {status === "done" && isError && (
        <div
          style={{
            position: "absolute",
            right: s(8),
            left: s(8),
            bottom: s(42),
            background: "rgba(22, 12, 12, 0.92)",
            border: "1px solid rgba(239, 68, 68, 0.45)",
            borderRadius: s(6),
            padding: `${s(6)} ${s(10)}`,
            boxShadow: "0 4px 16px rgba(0, 0, 0, 0.55)",
            animation: "fadeInUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
            pointerEvents: "auto",
            display: "flex",
            flexDirection: "column",
            zIndex: 10,
          }}
        >
          <span style={{
            color: "#fca5a5",
            fontSize: s(10),
            lineHeight: s(14),
            fontWeight: 500,
            wordBreak: "break-word",
          }}>
            {transcribedText}
          </span>
        </div>
      )}

      {/* Dynamic Keyframes */}
      <style>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes shimmer {
          0% { opacity: 0.5; }
          100% { opacity: 1; }
        }
        @keyframes menuFadeIn {
          from { opacity: 0; transform: translateY(4px) scale(0.95); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
