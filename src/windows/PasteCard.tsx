import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import logoIcon from "../assets/brand/logo_icon.png";

/**
 * PasteCard — shown when a dictation had nowhere to go (no text box focused, or the
 * paste failed). Holds the text with a Copy button and closes itself after a few
 * seconds (paused while hovered). Window "card"; see pastecard.rs.
 */
const LIFETIME = 12; // seconds

const INK = "#151914";
const CREAM = "#fffaf1";
const ACCENT = "#d66a2a";

export default function PasteCard() {
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const [left, setLeft] = useState(LIFETIME);
  const hovered = useRef(false);

  useEffect(() => {
    document.body.style.background = "transparent";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    invoke<string | null>("get_paste_card").then((t) => t && setText(t)).catch(() => {});
    const un = listen<string>("paste-card", (e) => {
      setText(e.payload);
      setCopied(false);
      setLeft(LIFETIME);
    });
    return () => { un.then((f) => f()); };
  }, []);

  // Countdown (paused on hover); closes at zero.
  useEffect(() => {
    if (!text) return;
    const id = setInterval(() => {
      if (hovered.current) return;
      setLeft((l) => {
        const n = Math.max(0, l - 0.1);
        if (n === 0) close();
        return n;
      });
    }, 100);
    return () => clearInterval(id);
  }, [text]);

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

  const R = 13, C = 2 * Math.PI * R;
  return (
    <div
      onMouseEnter={() => { hovered.current = true; }}
      onMouseLeave={() => { hovered.current = false; }}
      style={{
        position: "fixed", inset: 6,
        display: "flex", flexDirection: "column", gap: 10,
        padding: "14px 16px 14px 18px",
        background: CREAM, color: INK,
        border: `1.5px solid ${INK}`, borderRadius: 18,
        boxShadow: "0 10px 28px rgba(0,0,0,0.22)",
        fontFamily: "'Manrope', -apple-system, sans-serif",
        userSelect: "none",
        animation: "pc-in 260ms cubic-bezier(0.16, 1, 0.3, 1) both",
      }}
    >
      {/* Header: logo + what happened + close (ring shows time left) */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <img src={logoIcon} alt="" style={{ width: 22, height: 22, objectFit: "contain" }} />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "-0.01em" }}>Nothing to paste into</span>
          <span style={{ fontSize: 11.5, opacity: 0.6, fontWeight: 600 }}>Click a text box first next time. Here's what you said:</span>
        </div>
        <button
          onClick={close}
          aria-label="Close"
          style={{
            position: "relative", width: 30, height: 30, flex: "none",
            border: "none", background: "transparent", cursor: "pointer", padding: 0, color: INK,
          }}
        >
          <svg width="30" height="30" viewBox="0 0 30 30" style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}>
            <circle cx="15" cy="15" r={R} fill="none" stroke="rgba(21,25,20,0.12)" strokeWidth="2" />
            <circle cx="15" cy="15" r={R} fill="none" stroke={ACCENT} strokeWidth="2" strokeLinecap="round"
              strokeDasharray={C} strokeDashoffset={C * (1 - left / LIFETIME)} style={{ transition: "stroke-dashoffset 100ms linear" }} />
          </svg>
          <svg width="30" height="30" viewBox="0 0 30 30" style={{ position: "absolute", inset: 0 }}>
            <path d="M11 11l8 8M19 11l-8 8" stroke={INK} strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* The dictated text */}
      <div style={{
        flex: 1, minHeight: 0, overflowY: "auto",
        padding: "8px 11px", borderRadius: 11,
        background: "rgba(21,25,20,0.05)", border: "1px solid rgba(21,25,20,0.12)",
        fontSize: 13.5, lineHeight: 1.4, fontWeight: 600,
        userSelect: "text", cursor: "text",
      }}>
        {text}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          onClick={copy}
          className="pc-copy"
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "7px 16px", borderRadius: 999,
            border: `1.5px solid ${INK}`,
            background: copied ? ACCENT : INK, color: CREAM,
            fontFamily: "inherit", fontSize: 12.5, fontWeight: 800, cursor: "pointer",
            transition: "background 140ms ease, transform 100ms ease",
          }}
        >
          {copied ? (
            <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={CREAM} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>Copied</>
          ) : (
            <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={CREAM} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>Copy</>
          )}
        </button>
      </div>

      <style>{`
        @keyframes pc-in { from { opacity: 0; transform: translateY(6px) scale(0.98); } to { opacity: 1; transform: none; } }
        .pc-copy:hover { background: ${ACCENT} !important; }
        .pc-copy:active { transform: scale(0.97); }
      `}</style>
    </div>
  );
}
