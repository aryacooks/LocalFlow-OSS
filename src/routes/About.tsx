import { ExternalLink } from "lucide-react";
import logoWhite from "../assets/brand/logo_white.png";
import WifiOffIcon from "../components/ui/wifi-off-icon";
import Stack3Icon from "../components/ui/stack-3-icon";
import BrandWindowsIcon from "../components/ui/brand-windows-icon";
import AppleBrandLogo from "../components/ui/apple-brand-logo";
import BookIcon from "../components/ui/book-icon";
import UserIcon from "../components/ui/user-icon";
import LoopingIcon from "../components/LoopingIcon";

const ICON_COLOR = "#151914";

const DEPS = [
  { name: "whisper.cpp", desc: "C/C++ speech inference engine", license: "MIT", url: "https://github.com/ggml-org/whisper.cpp" },
  { name: "whisper-rs", desc: "Rust bindings for whisper.cpp", license: "MIT", url: "https://github.com/tazz4843/whisper-rs" },
  { name: "Tauri", desc: "Security-focused desktop app runner", license: "Apache-2.0 / MIT", url: "https://tauri.app" },
  { name: "cpal", desc: "Low-level system audio interface", license: "Apache-2.0", url: "https://github.com/RustAudio/cpal" },
  { name: "rusqlite", desc: "Local SQLite persistence client", license: "MIT", url: "https://github.com/rusqlite/rusqlite" },
  { name: "React", desc: "Declarative UI rendering library", license: "MIT", url: "https://react.dev" },
  { name: "Recharts", desc: "Interactive telemetric dashboard charts", license: "MIT", url: "https://recharts.org" },
  { name: "Zustand", desc: "Atomic frontend state management", license: "MIT", url: "https://github.com/pmndrs/zustand" },
];

const COMMITMENTS = [
  {
    icon: <WifiOffIcon size={14} color={ICON_COLOR} loop />,
    title: "Stays on your computer",
    desc: "Your voice and text never leave your device.",
    detail: "Nothing is uploaded to the internet and nothing is tracked. Everything you say is turned into text right on your own computer."
  },
  {
    icon: <LoopingIcon icon={UserIcon} size={14} color={ICON_COLOR} />,
    title: "No account needed",
    desc: "No sign-up, no subscription, no fees.",
    detail: "Just open the app and use it. No logging in, no payments, and it works without the internet."
  },
  {
    icon: <Stack3Icon size={14} color={ICON_COLOR} loop />,
    title: "Your data, your device",
    desc: "Your history and settings are saved only on this computer.",
    detail: "Your custom words, settings, and past dictations are kept in a private file on your device, never anywhere else."
  },
  {
    // Two platform marks: Windows + Mac (it works on both).
    icon: (
      <>
        <BrandWindowsIcon size={14} color={ICON_COLOR} loop />
        <AppleBrandLogo size={14} color={ICON_COLOR} loop />
      </>
    ),
    title: "Built for your computer",
    desc: "Works on Windows and Mac.",
    detail: "Made to work smoothly with your microphone, keyboard shortcuts, and your computer's speed."
  }
];

export default function AboutPage() {
  return (
    <div className="page narrow" style={{ paddingBottom: 24 }}>

      <div className="page-header">
        <div>
          <p className="page-kicker">Privacy-first voice to text</p>
          <h2 className="page-title">About LocalFlow</h2>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
          <span className="badge" style={{ background: "var(--warning)", color: "var(--warning-text)", border: "1.5px solid var(--separator)", boxShadow: "2px 2px 0px var(--separator)", fontWeight: 900, fontSize: 10, padding: "2px 8px" }}>
            VOL. 01 // LOCAL FLOW
          </span>
          <span className="badge" style={{ background: "var(--accent)", color: "var(--accent-text)", border: "1.5px solid var(--separator)", boxShadow: "2px 2px 0px var(--separator)", fontWeight: 900, fontSize: 10, padding: "2px 8px" }}>
            RELEASE BUILD
          </span>
        </div>
      </div>

      {/* Main panels */}
      <div className="grid cols-3" style={{ gap: 16, marginBottom: 20 }}>
        {/* Brand card */}
        <section className="glass-panel" style={{ gridColumn: "span 2", display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: 200, padding: 20 }}>
          <div className="about-lockup" style={{ marginBottom: 16 }}>
            <div className="about-icon" style={{ border: "2px solid var(--separator)", borderRadius: 6, padding: 4, background: "#151914", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <img src={logoWhite} alt="LocalFlow" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
            </div>
            <div>
              <h2 className="page-title" style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.5px" }}>LocalFlow</h2>
              <p className="page-kicker" style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)", margin: "2px 0 0 0" }}>Version 0.1.0 · Local Voice-to-Text</p>
            </div>
          </div>
          <p className="about-copy">
            LocalFlow turns your voice into text, right on your own computer. Just speak naturally, and it cleans up what you say and types it straight into whatever app you're using. No internet needed.
          </p>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--tertiary)" }}>
              Works offline · No tracking · Private by design
            </div>
            <a
              href="https://localflow.aryab.in"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "var(--accent)",
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              localflow.aryab.in <ExternalLink size={11} />
            </a>
          </div>
        </section>

        {/* Creator stamp */}
        <section className="glass-panel" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 20, background: "var(--warning)" }}>
          <div>
            <div style={{ fontSize: 9, fontWeight: 900, textTransform: "uppercase", letterSpacing: "1px", color: "var(--warning-text)" }}>
              // CREATOR
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 800, margin: "8px 0 4px", color: "var(--warning-text)" }}>Arya</h3>
            <p style={{ fontSize: 12, color: "rgba(21, 25, 20, 0.72)", lineHeight: "17px", margin: 0 }}>
              Didn't like paying for a voice-to-text transcriber, so I made one that's free. Enjoy!
            </p>
          </div>
          <a
            href="https://Aryab.in"
            target="_blank"
            rel="noopener noreferrer"
            className="button"
            style={{
              marginTop: 20,
              background: "#ffffff",
              color: "#151914",
              border: "1.5px solid #151914",
              boxShadow: "3px 3px 0px #151914",
              fontSize: 11,
              fontWeight: 800,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
              padding: "6px 0"
            }}
          >
            Visit Portfolio <ExternalLink size={12} />
          </a>
        </section>
      </div>

      {/* Trust Pillars */}
      <section style={{ marginBottom: 20 }}>
        <div className="section-label" style={{ marginBottom: 12 }}>
          Core System Trust Pillars
        </div>

        <div className="grid cols-2" style={{ gap: 16 }}>
          {COMMITMENTS.map((item, index) => {
            return (
              <div key={index} className="glass-panel" style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 5, minWidth: 28, height: 28, padding: "0 7px", borderRadius: 6, border: "1.5px solid var(--separator)", background: "var(--warning)", boxShadow: "2px 2px 0px var(--separator)", flexShrink: 0 }}>
                    {item.icon}
                  </div>
                  <h4 style={{ margin: 0, fontSize: 13.5, fontWeight: 800, color: "var(--label)" }}>{item.title}</h4>
                </div>
                <div style={{ marginTop: 4 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--accent)", marginBottom: 4 }}>{item.desc}</div>
                  <p style={{ margin: 0, fontSize: 11.5, lineHeight: "16px", color: "var(--secondary)" }}>{item.detail}</p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Dependencies */}
      <section>
        <div className="section-label" style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
          <LoopingIcon icon={BookIcon} size={13} /> Open-Source Engine Manifest
        </div>
        <div className="table-panel">
          {DEPS.map((dep) => (
            <div key={dep.name} className="setting-row" style={{ padding: "12px 16px", display: "grid", gridTemplateColumns: "150px 1fr auto", gap: 12 }}>
              <a
                href={dep.url}
                target="_blank"
                rel="noreferrer"
                className="license-link"
                style={{ fontSize: 13, fontWeight: 800, color: "var(--label)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                {dep.name} <ExternalLink size={11} color="var(--tertiary)" />
              </a>
              <span style={{ fontSize: 12, color: "var(--secondary)" }}>{dep.desc}</span>
              <span className="keycap" style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.2px" }}>{dep.license}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
