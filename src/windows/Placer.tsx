import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Placer — the drop guide shown only while the orb is being dragged (window "placer",
 * see placer.rs). Click-through and transparent: rings mark the 8 spots, the one the
 * orb will snap to lights up, and a short message sits in the middle of the screen.
 */
interface Spot { id: string; x: number; y: number; size: number }
interface Layout { spots: Spot[]; active: string | null; interactive: boolean }

const NAMES: Record<string, string> = {
  tl: "top left", tc: "top centre", tr: "top right",
  ml: "left edge", mr: "right edge",
  bl: "bottom left", bc: "bottom centre", br: "bottom right",
};

export default function Placer() {
  const [layout, setLayout] = useState<Layout>({ spots: [], active: null, interactive: false });

  useEffect(() => {
    document.body.style.background = "transparent";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    invoke<Layout>("get_placer_layout").then(setLayout).catch(() => {});
    const un = listen<Layout>("placer-layout", (e) => setLayout(e.payload));
    return () => { un.then((f) => f()); };
  }, []);

  // Esc leaves placement mode (the guide takes focus while it's open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") invoke("cancel_placing").catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pick = layout.interactive;
  const [hover, setHover] = useState<string | null>(null);

  return (
    <div style={{ position: "fixed", inset: 0, pointerEvents: pick ? "auto" : "none", userSelect: "none", fontFamily: "'Inter', -apple-system, sans-serif" }}>
      {/* A faint wash so the rings and message read on any wallpaper. Clicking it
          (anywhere but a spot) cancels placement mode. */}
      <div
        onClick={() => pick && invoke("cancel_placing").catch(() => {})}
        style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.12)", animation: "pl-in 160ms ease both" }}
      />

      {layout.spots.map((s) => {
        const on = pick ? s.id === hover : s.id === layout.active;
        const current = pick && s.id === layout.active;
        const d = s.size * 0.78;
        return (
          <div
            key={s.id}
            title={pick ? `Move the orb ${NAMES[s.id] ?? ""}` : undefined}
            onClick={() => pick && invoke("place_at_spot", { spot: s.id }).catch(() => {})}
            onMouseEnter={() => setHover(s.id)}
            onMouseLeave={() => setHover((h) => (h === s.id ? null : h))}
            style={{
            cursor: pick ? "pointer" : "default",
            opacity: current && !on ? 0.45 : 1,
            position: "absolute",
            left: s.x - d / 2, top: s.y - d / 2, width: d, height: d,
            borderRadius: "50%",
            border: on ? "2.5px solid #fff" : "2px dashed rgba(255,255,255,0.9)",
            background: on ? "rgba(255,255,255,0.28)" : "rgba(0,0,0,0.18)",
            boxShadow: on
              ? "0 0 0 1px rgba(0,0,0,0.35), 0 0 24px rgba(255,255,255,0.55)"
              : "0 0 0 1px rgba(0,0,0,0.3)",
            transform: on ? "scale(1.12)" : "scale(1)",
            transition: "transform 140ms ease, background 140ms ease, box-shadow 140ms ease",
            animation: "pl-in 200ms ease both",
          }} />
        );
      })}

      <div style={{
        position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
        padding: "14px 22px", borderRadius: 16,
        background: "rgba(16,16,18,0.86)", color: "#fff",
        boxShadow: "0 10px 30px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.08)",
        backdropFilter: "blur(14px)",
        animation: "pl-in 200ms ease both",
        textAlign: "center",
        whiteSpace: "nowrap",
      }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>
          {pick ? "Click a spot to move the orb" : "Drop the orb on a spot"}
        </span>
        <span style={{ fontSize: 12, opacity: 0.72 }}>
          {pick
            ? (hover ? `Move it ${NAMES[hover] ?? ""}` : "Press Esc to cancel")
            : layout.active ? `Let go to place it ${NAMES[layout.active] ?? ""}` : "It snaps to the nearest circle"}
        </span>
      </div>

      <style>{`@keyframes pl-in { from { opacity: 0; } to { opacity: 1; } }`}</style>
    </div>
  );
}
