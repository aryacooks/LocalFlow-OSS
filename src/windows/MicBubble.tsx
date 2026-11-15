import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getSetting, setBubbleVisible, setEarconsEnabled, getNotchGeometry, BUBBLE_SCALE_MIN, BUBBLE_SCALE_MAX } from "../lib/ipc";
import NotchIsland from "./NotchIsland";
import OrbBubble, { ORB_BOX, toOrbVariant, type OrbVariant, type OrbSignal } from "./OrbBubble";
import OrbMenu from "./OrbMenu";


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
/** A few words for the error pill next to the orb (the full text is its tooltip). */
function shortError(text: string): string {
  const t = text.replace(/^Error:\s*/, "").trim();
  if (/no audio/i.test(t)) return "No audio";
  if (/no speech/i.test(t)) return "No speech heard";
  if (/microphone|mic\b|device/i.test(t)) return "Mic problem";
  if (/model/i.test(t)) return "Model missing";
  return t.length > 18 ? "Didn't Work" : t || "Error";
}

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
  // The orb's colour follows the system appearance: black in light mode, white in
  // dark mode. (It never looks at the screen, so no Screen Recording is involved.)
  const [tint, setTint] = useState<"light" | "dark">(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setTint(mq.matches ? "dark" : "light");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
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
    const apply = (v: unknown) => { const o = toOrbVariant(v); if (o) setVariant(o); };
    getSetting("bubble_orb").then(apply).catch(() => {});
    const un2 = listen<string>("bubble-orb-changed", (e) => apply(e.payload));
    return () => { un2.then((f) => f()); };
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
      width = 200; height = 284;
    } else if (status === "done" && isError) {
      // Room for the short label beside the orb (above/below it in the centre column).
      if ((spot[1] ?? "r") === "c") { width = 160; height = ORB_BOX + 30; }
      else { width = ORB_BOX + 150; height = ORB_BOX; }
    } else {
      width = ORB_BOX; height = ORB_BOX; // same box idle and active, so the orb never jumps
    }
    // In notch mode Rust keeps the window at the notch and ignores the size.
    if (mode === "notch") return;
    invoke("resize_bubble", { width, height }).catch(() => {});
  }, [status, menuOpen, isError, uiScale, mode, spot]);

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
        // Language advice ("Sounded like Tamil. Add it in Language Model...") reads as it is.
        const plain = p.error === "Cancelled" || /Language Model|dictate in it/.test(p.error);
        setTranscribedText(plain ? p.error : `Error: ${p.error}`);
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

  // Diameter (in orb units) of the clickable circle. Idle: the dot (hover radius 8).
  // Transcribing / done: the settled disc (radius ~15). Listening: the full orb with
  // room for loud syllables (radius ~22).
  const hitSize =
    status === "recording" || status === "command" ? 46
    : status === "processing" || status === "done" ? 34
    : 18;

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
      {/* Hit target: exactly the orb as drawn, so clicks near it go to the app below.
          It grows with the orb: the idle dot is small, the listening orb is big (sizes
          from OrbBubble.tsx: radii × GROW). Click = start/stop, drag = move,
          right-click = menu. */}
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
          ...hAnchor((ORB_BOX - hitSize) / 2),
          ...vAnchor((ORB_BOX - hitSize) / 2),
          width: s(hitSize),
          height: s(hitSize),
          transition: "width .2s ease, height .2s ease, left .2s ease, right .2s ease, top .2s ease, bottom .2s ease",
          borderRadius: "50%",
          pointerEvents: "auto",
          cursor: drag.current?.moved ? "grabbing" : "pointer",
          touchAction: "none",
        }}
      />

      {/* ─── Right-Click Context Menu ─── */}
      {/* Sits on the side of the orb that faces the middle of the screen. */}
      {menuOpen && (
        <OrbMenu
          ref={menuRef}
          scale={uiScale}
          style={{ position: "absolute", ...hAnchor(8), ...(row === "t" ? { top: s(ORB_BOX) } : { top: s(8) }) }}
          privacy={privacy}
          sounds={sounds}
          onPrivacy={async () => {
            const v = await invoke<boolean>("toggle_privacy_mode").catch(() => null);
            if (v !== null) setPrivacy(v);
          }}
          onSounds={async () => {
            try { await setEarconsEnabled(!sounds); } catch (error) { console.error(error); }
          }}
          onHide={async () => {
            try { await setBubbleVisible(false); setMenuOpen(false); } catch (error) { console.error(error); }
          }}
          onOpenApp={async () => {
            setMenuOpen(false);
            await invoke("open_main_window").catch(console.error);
          }}
          onQuit={async () => {
            await invoke("quit_app").catch(console.error);
          }}
        />
      )}

      {/* ─── Error label: a short red pill beside the orb, on the side with room ─── */}
      {status === "done" && isError && (() => {
        const msg = shortError(transcribedText);
        const side: React.CSSProperties =
          col === "c"
            ? { left: "50%", transform: "translateX(-50%)", ...(row === "t" ? { top: s(ORB_BOX - 8) } : { bottom: s(ORB_BOX - 8) }) }
            : {
                ...(col === "r" ? { right: s(ORB_BOX / 2 + 22) } : { left: s(ORB_BOX / 2 + 22) }),
                ...(row === "t" ? { top: s(ORB_BOX / 2), transform: "translateY(-50%)" } : { bottom: s(ORB_BOX / 2), transform: "translateY(50%)" }),
              };
        return (
          <div style={{ position: "absolute", ...side, pointerEvents: "none" }}>
            <div
              title={transcribedText}
              style={{
                maxWidth: s(140), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                padding: `${s(5)} ${s(11)}`, borderRadius: 999,
                background: darkOrb ? "#b3261e" : "#ff453a", color: "#fff",
                border: `1px solid ${darkOrb ? "rgba(255,255,255,.35)" : "rgba(0,0,0,.3)"}`,
                boxShadow: "0 3px 12px rgba(0,0,0,.3)",
                fontSize: s(11.5), fontWeight: 700, letterSpacing: "0.01em",
                animation: `errIn${col === "c" ? "V" : col === "r" ? "L" : "R"} 0.32s cubic-bezier(0.16, 1, 0.3, 1) both`,
              }}
            >
              {msg}
            </div>
          </div>
        );
      })()}

      {/* Dynamic Keyframes */}
      <style>{`
        @keyframes errInL { from { opacity: 0; translate: 10px 0; } to { opacity: 1; translate: 0 0; } }
        @keyframes errInR { from { opacity: 0; translate: -10px 0; } to { opacity: 1; translate: 0 0; } }
        @keyframes errInV { from { opacity: 0; translate: 0 ${row === "t" ? "-6px" : "6px"}; } to { opacity: 1; translate: 0 0; } }
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
