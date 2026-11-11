/**
 * NotchIsland — the "Notch" bubble style (macOS).
 *
 * The window is fixed in Rust (notch.rs): flush with the top of the screen, centred on
 * the notch, `notch.width + 2 × WING` wide, `notch.height + DROP` tall, click-through.
 * Idle the island is the notch's exact size and transparent, so nothing shows.
 *
 *   listening   black wings grow out of the notch: red dot left, live voice wave right
 *   processing  the wave turns into a travelling shimmer while Whisper works
 *   done        a check on the left, then it tucks back in
 *   error       the island drops down below the notch and says what went wrong
 *               ("No speech", "No audio", …) in one short line
 *
 * No orb is drawn here: everything lives inside the black island.
 */
import { useEffect, useRef } from "react";

type Status = "idle" | "recording" | "processing" | "command" | "done";

// Must match notch.rs (WING / BOTTOM_PAD) — the window is sized from those.
const WING_MAX = 76;
const DROP = 30; // height of the message row the island grows when it has something to say

interface Props {
  status: Status;
  bars: number[];
  isError: boolean;
  text: string;
  notch: { width: number; height: number };
}

/** One short line for the island. Sentence case, no trailing punctuation. */
export function notchMessage(text: string): string {
  const t = text.replace(/^Error:\s*/, "").trim();
  if (/no audio/i.test(t)) return "No audio";
  if (/no speech/i.test(t)) return "No speech heard";
  if (/microphone|mic\b|device/i.test(t)) return "Mic problem";
  if (/model/i.test(t)) return "Model missing";
  if (/cancel/i.test(t)) return "Cancelled";
  return t.length > 22 ? "Didn't work" : t || "Didn't work";
}

/* ── Voice wave ─────────────────────────────────────────────────────────────
 * Thin rounded bars, mirrored around the middle line. Heights ease toward the mic
 * bands (fast attack, slow release) and get a little idle "breath" so the wave never
 * looks dead between words. While processing it becomes a travelling sine shimmer. */
const N = 13;

function VoiceWave({ bars, mode, color, height }: {
  bars: number[]; mode: "listen" | "think"; color: string; height: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const barsRef = useRef(bars);
  barsRef.current = bars;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = 58, H = height;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext("2d")!;
    ctx.scale(dpr, dpr);
    const cur = new Float32Array(N).fill(0.08);
    let raf = 0;
    const t0 = performance.now();

    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      const b = barsRef.current;
      const think = modeRef.current === "think";
      // Auto-gain: quiet mics still fill the wave.
      const peak = Math.max(0.12, ...b);
      ctx.clearRect(0, 0, W, H);
      const gap = W / N;
      const bw = 2.2;
      const maxH = H - 12;
      for (let i = 0; i < N; i++) {
        // Map 13 bars onto 8 bands symmetrically: centre = mids, edges = lows/highs.
        const centre = 1 - Math.abs(i - (N - 1) / 2) / ((N - 1) / 2); // 0 edge → 1 middle
        let target: number;
        if (think) {
          target = 0.18 + 0.22 * (0.5 + 0.5 * Math.sin(t * 7 - i * 0.7));
        } else {
          const band = b[Math.min(7, Math.round((1 - centre) * 7))] ?? 0;
          const v = Math.min(1, band / peak);
          const breath = 0.07 + 0.04 * Math.sin(t * 3.1 + i * 0.9);
          target = Math.max(breath, v * (0.45 + 0.55 * centre));
        }
        const k = target > cur[i] ? 0.45 : 0.14;
        cur[i] += (target - cur[i]) * k;
        const h = Math.max(2.2, cur[i] * maxH);
        const x = gap * i + (gap - bw) / 2;
        ctx.globalAlpha = think ? 0.55 + 0.45 * cur[i] : 0.55 + 0.45 * Math.min(1, cur[i] * 2);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x, (H - h) / 2, bw, h, bw / 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [color, height]);

  return <canvas ref={ref} style={{ width: 58, height }} />;
}

export default function NotchIsland({ status, bars, isError, text, notch }: Props) {
  const listening = status === "recording" || status === "command";
  const active = status !== "idle";
  const msg = status === "done" && (isError || /cancel/i.test(text)) ? notchMessage(text) : "";
  const cancelled = msg === "Cancelled";
  const dropped = msg !== "";

  const wing =
    listening ? 66
    : status === "processing" ? 66
    : status === "done" ? (dropped ? 46 : 38)
    : 0;
  const width = notch.width + 2 * Math.min(wing, WING_MAX);
  const h = notch.height;
  const height = h + (dropped ? DROP : 0);
  const radius = dropped ? 18 : Math.min(14, Math.round(h * 0.42));
  const ear = 7; // concave fillet where the island meets the top of the screen
  const accent = status === "command" ? "#b79bff" : "#ffffff";

  return (
    <div style={{
      position: "fixed", inset: 0, background: "transparent", pointerEvents: "none",
      userSelect: "none", overflow: "hidden",
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    }}>
      <div style={{
        position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)",
        width, height, background: "#000",
        borderBottomLeftRadius: radius, borderBottomRightRadius: radius,
        boxShadow: active ? "0 4px 14px rgba(0,0,0,0.32)" : "none",
        opacity: active ? 1 : 0,
        // Shrink first, then fade, so it visibly tucks back into the notch.
        transition: active
          ? "width 420ms cubic-bezier(0.32,0.72,0,1), height 380ms cubic-bezier(0.32,0.72,0,1), border-radius 380ms ease, opacity 120ms ease"
          : "width 360ms cubic-bezier(0.32,0.72,0,1), height 300ms cubic-bezier(0.32,0.72,0,1), opacity 160ms ease 240ms, box-shadow 200ms ease",
      }}>
        {/* Fillets so the island flows out of the screen edge like the notch does. */}
        <div style={{ position: "absolute", top: 0, left: -ear, width: ear, height: ear,
          background: `radial-gradient(circle at 0 100%, transparent ${ear - 0.5}px, #000 ${ear}px)` }} />
        <div style={{ position: "absolute", top: 0, right: -ear, width: ear, height: ear,
          background: `radial-gradient(circle at 100% 100%, transparent ${ear - 0.5}px, #000 ${ear}px)` }} />

        {/* Left wing */}
        <div style={{
          position: "absolute", left: 0, top: 0, height: h, width: wing,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {listening && (
            <div key="dot" className="ni-fade" style={{
              width: 8, height: 8, borderRadius: "50%",
              background: status === "command" ? "#b79bff" : "#ff453a",
              boxShadow: `0 0 8px ${status === "command" ? "rgba(183,155,255,.7)" : "rgba(255,69,58,.7)"}`,
              animation: "ni-pulse 1.4s ease-in-out infinite",
            }} />
          )}
          {status === "processing" && (
            <div key="spin" className="ni-fade" style={{
              width: 12, height: 12, borderRadius: "50%",
              border: "1.75px solid rgba(255,255,255,.22)", borderTopColor: "#fff",
              animation: "ni-spin .8s linear infinite",
            }} />
          )}
          {status === "done" && !dropped && (
            <svg key="ok" className="ni-fade" width="15" height="15" viewBox="0 0 24 24" fill="none"
              stroke="#30d158" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          )}
        </div>

        {/* Right wing: the voice wave */}
        <div style={{
          position: "absolute", right: 0, top: 0, height: h, width: wing,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {(listening || status === "processing") && (
            <div className="ni-fade" key="wave">
              <VoiceWave bars={bars} mode={listening ? "listen" : "think"} color={accent} height={h} />
            </div>
          )}
        </div>

        {/* Drop row: the message, under the notch */}
        {dropped && (
          <div key={msg} className="ni-drop" style={{
            position: "absolute", left: 0, right: 0, top: h - 2, height: DROP,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
            color: cancelled ? "rgba(255,255,255,.7)" : "#fff",
            fontSize: 13, fontWeight: 700, letterSpacing: "0.005em", whiteSpace: "nowrap",
          }}>
            <span style={{
              width: 16, height: 16, borderRadius: "50%", flex: "none",
              background: cancelled ? "rgba(255,255,255,.18)" : "#ff453a",
              display: "grid", placeItems: "center",
            }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round">
                {cancelled ? (<><path d="M17 7 7 17" /><path d="M7 7l10 10" /></>) : (<><path d="M12 6v7" /><path d="M12 18h.01" /></>)}
              </svg>
            </span>
            {msg}
          </div>
        )}
      </div>

      <style>{`
        .ni-fade { animation: ni-in 220ms ease both; }
        .ni-drop { animation: ni-drop 340ms cubic-bezier(0.16,1,0.3,1) 80ms both; }
        @keyframes ni-in { from { opacity: 0; transform: scale(.6); } to { opacity: 1; transform: scale(1); } }
        @keyframes ni-drop { from { opacity: 0; transform: translateY(-6px); filter: blur(3px); } to { opacity: 1; transform: none; filter: none; } }
        @keyframes ni-pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .55; transform: scale(.82); } }
        @keyframes ni-spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
