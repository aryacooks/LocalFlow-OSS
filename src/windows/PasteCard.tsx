import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import logoIcon from "../assets/brand/logo_icon.png";

/**
 * PasteCard — shown when a dictation had nowhere to go (no text box focused, or the
 * paste failed). Holds the text with a Copy button. It closes itself after a few
 * seconds (paused while hovered); the countdown runs in pastecard.rs, which sends the
 * fraction left. Window "card".
 */
const LIFETIME = 10; // seconds; keep in sync with pastecard::LIFETIME

const INK = "#151914";
const CARD = "#fcfbf9";
const MUTED = "rgba(21,25,20,0.55)";
const ACCENT = "#d66a2a";

export default function PasteCard() {
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const [left, setLeft] = useState(1); // fraction of the lifetime left
  const [paused, setPaused] = useState(false); // pointer is over the card

  useEffect(() => {
    document.body.style.background = "transparent";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    invoke<string | null>("get_paste_card").then((t) => t && setText(t)).catch(() => {});
    const un = listen<string>("paste-card", (e) => {
      setText(e.payload);
      setCopied(false);
      setLeft(1);
      setPaused(false);
    });
    const unLeft = listen<[number, boolean]>("paste-card-left", (e) => {
      setLeft(e.payload[0]);
      setPaused(e.payload[1]);
    });
    return () => { un.then((f) => f()); unLeft.then((f) => f()); };
  }, []);

  const close = () => {
    invoke("hide_paste_card").catch(() => {});
    setTimeout(() => setText(""), 50);
  };

  const copy = async () => {
    try {
      await invoke("copy_to_clipboard", { text });
      setCopied(true);
      setTimeout(close, 1100);
    } catch (e) {
      console.error(e);
    }
  };

  if (!text) return null;

  const secs = Math.max(1, Math.ceil(left * LIFETIME - 0.05));
  const R = 13, C = 2 * Math.PI * R;
  return (
    <div
      style={{
        // Laid out at design size, drawn 20% smaller (the window is 320×186).
        position: "fixed", top: 7.5, left: 7.5, width: 400 - 15, height: 232 - 15,
        boxSizing: "border-box", zoom: 0.8,
        display: "flex", flexDirection: "column",
        padding: "18px 18px 16px 20px",
        background: CARD, color: INK,
        border: "1px solid rgba(21,25,20,0.08)", borderRadius: 22,
        boxShadow: "0 12px 32px rgba(0,0,0,0.28)",
        fontFamily: "'Manrope', -apple-system, sans-serif",
        userSelect: "none",
        animation: "pc-in 260ms cubic-bezier(0.16, 1, 0.3, 1) both",
      }}
    >
      {/* Header: logo + title + close */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <img src={logoIcon} alt="" style={{ width: 24, height: 24, objectFit: "contain" }} />
        <span style={{ flex: 1, fontSize: 17, fontWeight: 800, letterSpacing: "-0.015em" }}>Nothing to paste</span>
        <button onPointerDown={(e) => { e.preventDefault(); close(); }} aria-label="Close" className="pc-x" title="Close">
          <span className="pc-x-dot">
            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 2l10 10M12 2L2 12" stroke={INK} strokeWidth="2" strokeLinecap="round" /></svg>
          </span>
        </button>
      </div>
      <span style={{ marginTop: 6, fontSize: 12.5, fontWeight: 600, color: MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        Click a text box first next time. Here's what you said:
      </span>

      {/* The dictated text */}
      <div style={{
        marginTop: 12, flex: 1, minHeight: 40, overflowY: "auto",
        padding: "9px 14px", borderRadius: 12,
        background: "rgba(21,25,20,0.05)",
        fontSize: 14.5, lineHeight: 1.4, fontWeight: 600,
        userSelect: "text", cursor: "text",
      }}>
        {text}
      </div>

      {/* Footer: countdown + Copy */}
      <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ position: "relative", width: 30, height: 30, flex: "none" }}>
          <svg width="30" height="30" viewBox="0 0 30 30" style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}>
            <circle cx="15" cy="15" r={R} fill="none" stroke="rgba(21,25,20,0.12)" strokeWidth="2.4" />
            <circle cx="15" cy="15" r={R} fill="none" stroke={INK} strokeWidth="2.4" strokeLinecap="round"
              strokeDasharray={C} strokeDashoffset={C * (1 - left)} style={{ transition: "stroke-dashoffset 100ms linear" }} />
          </svg>
          <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 10.5, fontWeight: 800 }}>{secs}s</span>
        </div>
        <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: MUTED }}>
          {paused ? "Paused while you're here" : `Closing in ${secs} second${secs === 1 ? "" : "s"}`}
        </span>
        <button onClick={copy} className="pc-copy" style={{ background: copied ? ACCENT : INK }}>
          {copied ? (
            <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>Copied</>
          ) : (
            <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>Copy</>
          )}
        </button>
      </div>

      <style>{`
        @keyframes pc-in { from { opacity: 0; transform: translateY(6px) scale(0.98); } to { opacity: 1; transform: none; } }
        /* Big invisible hit area (reaches the card's top-right corner) around a 32px dot. */
        .pc-x { width: 56px; height: 56px; margin: -14px -14px -14px 0; flex: none; border: none;
          background: transparent; display: grid; place-items: center; cursor: pointer; padding: 0; }
        .pc-x-dot { width: 34px; height: 34px; border-radius: 50%; background: rgba(21,25,20,0.08);
          display: grid; place-items: center; transition: background 140ms ease; }
        .pc-x:hover .pc-x-dot { background: rgba(21,25,20,0.16); }
        .pc-copy { display: inline-flex; align-items: center; gap: 7px; padding: 9px 20px; border-radius: 12px;
          border: none; color: #fff; font-family: inherit; font-size: 13.5px; font-weight: 800; cursor: pointer;
          transition: background 140ms ease, transform 100ms ease; }
        .pc-copy:hover { background: ${ACCENT} !important; }
        .pc-copy:active { transform: scale(0.97); }
      `}</style>
    </div>
  );
}
