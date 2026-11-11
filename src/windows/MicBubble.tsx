import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getSetting, setBubbleVisible, setEarconsEnabled, getNotchGeometry, BUBBLE_SCALE_MIN, BUBBLE_SCALE_MAX } from "../lib/ipc";
import NotchIsland from "./NotchIsland";
import OrbBubble, { ORB_BOX, type OrbVariant, type OrbSignal } from "./OrbBubble";
import { EyeOff, Volume2, VolumeX } from "lucide-react";


// Manual bubble-size override → content scale. MUST stay in sync with the Rust
// `bubble_size_to_scale` in lib.rs (window size there, content size here), or the
// logo ends up the wrong size for its window. Returns null for "auto" or anything
// unparseable so we fall back to the geometry-based heuristic.
function bubbleSizeToScale(size: string | null): number | null {
  if (size == null) return null;
  const raw = Number.parseFloat(size);
  if (!Number.isFinite(raw)) return null;
  return Math.min(Math.max(raw, BUBBLE_SCALE_MIN), BUBBLE_SCALE_MAX);
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
  // Which of the 8 screen spots the orb is in ("br" = bottom-right). The window grows
  // away from the screen edge, so the orb is laid out at the matching window corner.
  const [spot, setSpot] = useState("br");
  const drag = useRef<{ sx: number; sy: number; wx: number; wy: number; moved: boolean; raf: number } | null>(null);
  const suppressClick = useRef(false);
  const [uiScale, setUiScale] = useState(1);
  // The orb's colour follows what's behind it: Rust samples the screen under the
  // bubble and sends `bubble-tint` ("light" background → black orb, "dark" → white).
  const [tint, setTint] = useState<"light" | "dark">("light");
  const [variant, setVariant] = useState<OrbVariant>("blob");
  const signal = useRef<OrbSignal>({ level: 0, bands: Array(8).fill(0) });
  const [privacy, setPrivacy] = useState(false);
  const [sounds, setSounds] = useState(true);
  // "classic" floating mic, or the "notch" island (macOS; window placed by Rust).
  const [mode, setMode] = useState<"classic" | "notch">("classic");
  const [notch, setNotch] = useState({ width: 186, height: 32 });
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
    const isVariant = (v: unknown): v is OrbVariant =>
      v === "sunburst" || v === "blob" || v === "orbit" || v === "liquid" || v === "pebble" || v === "minibars";
    getSetting("bubble_orb").then((v) => { if (isVariant(v)) setVariant(v); }).catch(() => {});
    const un2 = listen<string>("bubble-orb-changed", (e) => { if (isVariant(e.payload)) setVariant(e.payload); });
    const un3 = listen<string>("bubble-tint", (e) => setTint(e.payload === "dark" ? "dark" : "light"));
    return () => { un2.then((f) => f()); un3.then((f) => f()); };
  }, []);

  // Bubble style + the notch's real size, kept in sync with Settings.
  useEffect(() => {
    getSetting("bubble_style").then((v) => setMode(v === "notch" ? "notch" : "classic")).catch(() => {});
    getNotchGeometry().then((g) => setNotch({ width: g.width, height: g.height })).catch(() => {});
    invoke<[string, number]>("get_bubble_placement").then(([sp]) => setSpot(sp)).catch(() => {});
    const unPlace = listen<{ spot: string }>("bubble-placement-changed", (e) => setSpot(e.payload.spot));
    const un = listen<string>("bubble-mode-changed", (e) => {
      setMode(e.payload === "notch" ? "notch" : "classic");
      setMenuOpen(false);
    });
    return () => { un.then((f) => f()); unPlace.then((f) => f()); };
  }, []);

  // Mirror incognito (privacy) mode, kept in sync with the sidebar/tray.
  useEffect(() => {
    getSetting("play_sounds").then((v) => setSounds(v !== "false")).catch(console.error);
    const un = listen<{ sounds?: boolean }>("display-settings-changed", ({ payload }) => {
      if (payload.sounds !== undefined) setSounds(payload.sounds);
    });
    return () => { un.then((f) => f()); };
  }, []);

  useEffect(() => {
    invoke<boolean>("get_privacy_mode").then(setPrivacy).catch(() => {});
    const un = listen<boolean>("privacy-changed", (e) => setPrivacy(e.payload));
    return () => { un.then((f) => f()); };
  }, []);

  useEffect(() => {
    // Derive the UI scale from the display size (mirrors the Rust `bubble_scale`),
    // not the window width — the window now resizes per state, so keying off
    // innerWidth would make the logo jump sizes between states. A manual bubble-size
    // override (Settings → Display) wins over the auto heuristic.
    const updateScale = async () => {
      let override: number | null = null;
      try {
        override = bubbleSizeToScale(await getSetting("bubble_size"));
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
    const unlisten = listen("bubble-size-changed", () => { updateScale(); });
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
      width = 200; height = 264;
    } else if (status === "done" && isError) {
      width = 240; height = 120; // room for the error message above the orb
    } else {
      width = ORB_BOX; height = ORB_BOX; // same box idle and active, so the orb never jumps
    }
    // In notch mode Rust keeps the window at the notch and ignores the size.
    if (mode === "notch") return;
    invoke("resize_bubble", { width, height }).catch(() => {});
  }, [status, menuOpen, isError, uiScale, mode]);

  // Done auto-collapse sequence
  useEffect(() => {
    if (status === "done") {
      const id = setTimeout(() => {
        setStatus("idle");
        setTranscribedText("");
        setIsError(false);
      }, mode === "notch" ? (isError ? 2200 : 1100) : 2500);
      return () => clearTimeout(id);
    }
  }, [status, mode, isError]);

  // Audio levels, polled only while listening (~30 Hz). The orb reads `signal` every
  // frame; the notch island renders `bars` (the same bands).
  const listening = status === "recording" || status === "command";
  useEffect(() => {
    if (!listening) {
      signal.current = { level: 0, bands: Array(8).fill(0) };
      return;
    }
    ampRef.current = setInterval(async () => {
      try {
        const a = await invoke<{ level?: number; bands?: number[] }>("get_amplitude");
        const bands = a?.bands?.length ? a.bands.slice(0, 8) : Array(8).fill(0);
        signal.current = { level: a?.level ?? 0, bands };
        setBars(bands);
      } catch { /* keep the last values */ }
    }, 33);
    return () => { if (ampRef.current) clearInterval(ampRef.current); };
  }, [listening]);

  // State listeners
  useEffect(() => {

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
      u1.then(f => f());
      u2.then(f => f());
      u3.then(f => f());
      u4.then(f => f());
    };
  }, []);

  /* ── Actions ────────────────────────────────────────────────── */
  // Drag the orb anywhere; on release it snaps to the nearest of the 8 spots (Rust).
  // macOS keeps sending moves to this window while the button is held, even when the
  // pointer is outside it, so plain pointer events are enough.
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || menuOpen) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const d = { sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY, moved: false, raf: 0 };
    drag.current = d;
    // Exact window origin in points (window.screenX can be off by the title-less frame).
    const w = getCurrentWindow();
    Promise.all([w.outerPosition(), w.scaleFactor()])
      .then(([p, sf]) => { if (drag.current === d) { d.wx = p.x / sf; d.wy = p.y / sf; } })
      .catch(() => {});
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.screenX - d.sx, dy = e.screenY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    cancelAnimationFrame(d.raf);
    d.raf = requestAnimationFrame(() => {
      invoke("drag_bubble", { x: d.wx + dx, y: d.wy + dy }).catch(() => {});
    });
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    cancelAnimationFrame(d.raf);
    suppressClick.current = true; // the click that ends a drag isn't a tap
    invoke<string | null>("drop_bubble").then((sp) => { if (sp) setSpot(sp); }).catch(() => {});
  };

  const handleClick = async () => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    if (menuOpen) return;
    if (status === "recording" || status === "command") {
      // Mid-dictation a click still finishes it.
      await invoke("stop_and_transcribe_cmd").catch(console.error);
    } else if (status === "idle" || status === "done") {
      // Otherwise a click opens placement mode (dictation is started with the
      // shortcut): pick a spot, or Esc / click the orb again to cancel.
      await invoke("toggle_placing").catch(console.error);
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


  const s = (value: number) => `${value * uiScale}px`;

  // Black orb on light backgrounds, white orb on dark ones.
  const darkOrb = tint === "light";

  // Lay the orb out at the window corner that faces the screen edge (mirrors
  // placement::window_origin in Rust).
  const col = spot[1] ?? "r", row = spot[0] ?? "b";
  const hAnchor = (inset: number): React.CSSProperties =>
    col === "l" ? { left: s(inset) } : col === "r" ? { right: s(inset) } : { left: "50%", transform: "translateX(-50%)" };
  const vAnchor = (inset: number): React.CSSProperties =>
    row === "t" ? { top: s(inset) } : { bottom: s(inset) };

  if (mode === "notch") {
    return <NotchIsland status={status} bars={bars} isError={isError} text={transcribedText} notch={notch} />;
  }

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
      {/* ─── Orb ─── */}
      <div style={{ position: "absolute", ...hAnchor(0), ...vAnchor(0), pointerEvents: "none" }}>
        <OrbBubble
          variant={variant}
          status={status}
          dark={darkOrb}
          isError={isError}
          cancelled={status === "done" && transcribedText === "Cancelled"}
          hovered={logoHovered || menuOpen}
          uiScale={uiScale}
          signal={signal}
        />
      </div>
      {/* Hit target: the orb's middle. Click = start/stop, drag = move, right-click = menu. */}
      <div
        ref={logoRef}
        onClick={handleClick}
        onContextMenu={handleRightClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onMouseEnter={() => setLogoHovered(true)}
        onMouseLeave={() => setLogoHovered(false)}
        style={{
          position: "absolute",
          ...hAnchor((ORB_BOX - 40) / 2),
          ...vAnchor((ORB_BOX - 40) / 2),
          width: s(40),
          height: s(40),
          borderRadius: "50%",
          pointerEvents: "auto",
          cursor: drag.current?.moved ? "grabbing" : "pointer",
          touchAction: "none",
        }}
      />

      {/* ─── Right-Click Context Menu ─── */}
      {/* Sits on the side of the orb that faces the middle of the screen. */}
      {menuOpen && (
        <div
          ref={menuRef}
          style={{
            position: "absolute",
            ...hAnchor(8),
            ...(row === "t" ? { top: s(ORB_BOX) } : { top: s(8) }),
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
          <button className="bubble-menu-action" onClick={async () => {
            try { await setEarconsEnabled(!sounds); } catch (error) { console.error(error); }
          }}>
            {sounds ? <Volume2 size={14 * uiScale} /> : <VolumeX size={14 * uiScale} />}
            <span style={{ flex: 1 }}>Sounds</span>
            <span style={{ fontSize: s(10), opacity: 0.85 }}>{sounds ? "On" : "Muted"}</span>
          </button>
          <button className="bubble-menu-action" onClick={async () => {
            try { await setBubbleVisible(false); setMenuOpen(false); } catch (error) { console.error(error); }
          }}>
            <EyeOff size={14 * uiScale} />
            Hide bubble
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

      {/* ─── Full Error Message Callout (Displayed on Top) ─── */}
      {status === "done" && isError && (
        <div
          style={{
            position: "absolute",
            right: s(8),
            left: s(8),
            ...(row === "t" ? { top: s(ORB_BOX - 4) } : { bottom: s(ORB_BOX - 4) }),
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
        .bubble-menu-action {
          display: flex; align-items: center; gap: ${s(8)}; width: 100%;
          padding: ${s(7)} ${s(10)}; background: transparent; border: none;
          border-radius: ${s(5)}; color: #e4e4e7; font-size: ${s(12)};
          font-weight: 500; font-family: inherit; cursor: pointer; text-align: left;
        }
        .bubble-menu-action:hover, .bubble-menu-action:focus-visible {
          background: rgba(255,255,255,0.08);
        }
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes menuFadeIn {
          from { opacity: 0; transform: translateY(4px) scale(0.95); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
