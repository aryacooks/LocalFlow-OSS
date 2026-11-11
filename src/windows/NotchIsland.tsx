/**
 * NotchIsland — the "Notch island" bubble style (macOS).
 *
 * The window is fixed in Rust (notch.rs): flush with the top of the screen, centred on
 * the notch, `notch.width + 2 × WING` wide and click-through. Idle the island is the
 * notch's exact size and fully transparent, so nothing shows. While dictating it widens
 * into black "wings": a recording dot on the left, the live voice wave on the right.
 */
type Status = "idle" | "recording" | "processing" | "command" | "done";

// Must match notch.rs (WING / BOTTOM_PAD) — the window is sized from those.
const WING_MAX = 76;

interface Props {
  status: Status;
  bars: number[];
  isError: boolean;
  text: string;
  notch: { width: number; height: number };
}

export default function NotchIsland({ status, bars, isError, text, notch }: Props) {
  const listening = status === "recording" || status === "command";
  const active = status !== "idle";
  const cancelled = status === "done" && text === "Cancelled";

  const wing =
    listening ? 62
    : status === "processing" ? 36
    : status === "done" ? 36
    : 0;
  const width = notch.width + 2 * Math.min(wing, WING_MAX);
  const h = notch.height;
  const radius = Math.min(14, Math.round(h * 0.42));
  const ear = 7; // concave fillet where the island meets the top of the screen
  const accent = status === "command" ? "#b79bff" : "#ffffff";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "transparent",
        pointerEvents: "none",
        userSelect: "none",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: "50%",
          transform: "translateX(-50%)",
          width,
          height: h,
          background: "#000",
          borderBottomLeftRadius: radius,
          borderBottomRightRadius: radius,
          boxShadow: active ? "0 3px 10px rgba(0,0,0,0.28)" : "none",
          opacity: active ? 1 : 0,
          // Shrink first, then fade, so it visibly tucks back into the notch.
          transition: active
            ? "width 420ms cubic-bezier(0.32, 0.72, 0, 1), opacity 120ms ease"
            : "width 360ms cubic-bezier(0.32, 0.72, 0, 1), opacity 160ms ease 240ms, box-shadow 200ms ease",
        }}
      >
        {/* Fillets so the island flows out of the screen edge like the notch does. */}
        <div style={{
          position: "absolute", top: 0, left: -ear, width: ear, height: ear,
          background: `radial-gradient(circle at 0 100%, transparent ${ear - 0.5}px, #000 ${ear}px)`,
        }} />
        <div style={{
          position: "absolute", top: 0, right: -ear, width: ear, height: ear,
          background: `radial-gradient(circle at 100% 100%, transparent ${ear - 0.5}px, #000 ${ear}px)`,
        }} />

        {/* Left wing */}
        <div style={{
          position: "absolute", left: 0, top: 0, bottom: 0, width: wing,
          display: "flex", alignItems: "center", justifyContent: "center",
          paddingLeft: radius * 0.35,
        }}>
          {listening && (
            <div key="dot" className="ni-fade" style={{
              width: 8, height: 8, borderRadius: "50%",
              background: status === "command" ? "#b79bff" : "#ff453a",
              boxShadow: `0 0 8px ${status === "command" ? "rgba(183,155,255,0.7)" : "rgba(255,69,58,0.7)"}`,
              animation: "ni-pulse 1.4s ease-in-out infinite",
            }} />
          )}
          {status === "processing" && (
            <div key="spin" className="ni-fade" style={{
              width: 12, height: 12, borderRadius: "50%",
              border: "1.75px solid rgba(255,255,255,0.22)",
              borderTopColor: "#fff",
              animation: "ni-spin 0.8s linear infinite",
            }} />
          )}
          {status === "done" && (
            <svg key="done" className="ni-fade" width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke={isError ? "#ff6961" : cancelled ? "rgba(255,255,255,0.55)" : "#fff"}
              strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              {isError ? (<><path d="M12 7v6" /><path d="M12 17h.01" /></>)
                : cancelled ? (<><path d="M17 7 7 17" /><path d="M7 7l10 10" /></>)
                : <path d="M5 12.5l4.5 4.5L19 7.5" />}
            </svg>
          )}
        </div>

        {/* Right wing */}
        <div style={{
          position: "absolute", right: 0, top: 0, bottom: 0, width: wing,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 2.5,
          paddingRight: radius * 0.35,
        }}>
          {listening && bars.slice(0, 8).map((amp, i) => (
            <div key={i} style={{
              width: 2.5,
              height: Math.max(3, Math.min(1, amp) * (h - 14)),
              borderRadius: 2,
              background: accent,
              transition: "height 90ms linear",
            }} />
          ))}
          {status === "processing" && [0, 1, 2].map((i) => (
            <div key={i} style={{
              width: 3.5, height: 3.5, borderRadius: "50%", background: "#fff",
              animation: `ni-dot 1s ease-in-out ${i * 0.15}s infinite`,
            }} />
          ))}
        </div>
      </div>

      <style>{`
        .ni-fade { animation: ni-in 220ms ease both; }
        @keyframes ni-in { from { opacity: 0; transform: scale(0.6); } to { opacity: 1; transform: scale(1); } }
        @keyframes ni-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.55; transform: scale(0.82); } }
        @keyframes ni-spin { to { transform: rotate(360deg); } }
        @keyframes ni-dot { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
      `}</style>
    </div>
  );
}
