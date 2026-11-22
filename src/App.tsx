import { Routes, Route, NavLink, Link, Navigate, useLocation } from "react-router-dom";
import {
  Download,
  CircleAlert,
  Keyboard,
  Lightbulb,
  Moon,
  Shield,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import GhostIcon from "./components/ui/ghost-icon";
import LayoutDashboardIcon from "./components/ui/layout-dashboard-icon";
import HistoryCircleIcon from "./components/ui/history-circle-icon";
import DownloadIcon from "./components/ui/download-icon";
import SparklesIcon from "./components/ui/sparkles-icon";
import GearIcon from "./components/ui/gear-icon";
import InfoCircleIcon from "./components/ui/info-circle-icon";
import LoopingIcon from "./components/LoopingIcon";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "./lib/store";
import PlugConnectedIcon from "./components/ui/plug-connected-icon";
import BugIcon from "./components/ui/bug-icon";
import type { AnimatedIconHandle } from "./components/ui/types";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listModels, listAudioDevices, getSetting, isLlamaCliInstalled, listLlmModels, getPermissionStatus, checkUpdate } from "./lib/ipc";

import ThemeTransitionOverlay from "./ThemeTransitionOverlay";
import OnboardingWizard from "./components/OnboardingWizard";

import logoWhite from "./assets/brand/logo_white.png";
import logoIcon from "./assets/brand/logo_icon.png";

import AboutPage from "./routes/About";
import Dashboard from "./routes/Dashboard";
import HistoryPage from "./routes/History";
import ModelsPage from "./routes/Models";
import SettingsPage from "./routes/Settings";
import ShortcutsPage from "./routes/Shortcuts";
import LLMSettingsPage from "./routes/LLMSettings";
import TipsPage from "./routes/Tips";

const BUG_REPORT_URL = "https://localflow.aryab.in/contact";

// Sidebar nav. Items with `animated` use an itshover-style icon that loops while
// its page is open (via LoopingIcon); Shortcuts has no animated icon, so it stays
// on the static lucide glyph.
const navItems = [
  { to: "/", animated: LayoutDashboardIcon, label: "Dashboard" },
  { to: "/history", animated: HistoryCircleIcon, label: "History" },
  { to: "/shortcuts", icon: Keyboard, label: "Shortcuts" },
  { to: "/models", animated: DownloadIcon, label: "Language Model" },
  { to: "/llm", animated: SparklesIcon, label: "Formatting options" },
  { to: "/tips", icon: Lightbulb, label: "Tips" },
  { to: "/settings", animated: GearIcon, label: "Settings" },
  { to: "/about", animated: InfoCircleIcon, label: "About" },
] as const;

/** Sidebar setup reminders — one square box per incomplete step, shown below About.
 *  Each disappears on its own once that step is done (polled in App). */
function SetupReminders({
  needModel,
  needFormatting,
  updateVersion,
}: {
  needModel: boolean;
  needFormatting: boolean;
  /** A newer LocalFlow on the website, if there is one. */
  updateVersion: string | null;
}) {
  if (!needModel && !needFormatting && !updateVersion) return null;
  return (
    <div className="setup-reminders">
      {updateVersion && (
        <Link to="/about" className="setup-reminder is-update">
          <div className="setup-reminder-head">
            <Download size={15} strokeWidth={2.4} />
            <span className="setup-reminder-title">Update available</span>
          </div>
          <p className="setup-reminder-desc">
            Version {updateVersion} is out. Open About to update in one click.
          </p>
        </Link>
      )}
      {needModel && (
        <Link to="/models" className="setup-reminder">
          <div className="setup-reminder-head">
            <Download size={15} strokeWidth={2.4} />
            <span className="setup-reminder-title">Download a model</span>
          </div>
          <p className="setup-reminder-desc">
            Get a speech model so LocalFlow can turn your voice into text.
          </p>
        </Link>
      )}
      {needFormatting && (
        <Link to="/llm" className="setup-reminder">
          <div className="setup-reminder-head">
            <Sparkles size={15} strokeWidth={2.4} />
            <span className="setup-reminder-title">Finish formatting setup</span>
          </div>
          <p className="setup-reminder-desc">
            Formatting is enabled, but its local helper or model is still missing.
          </p>
        </Link>
      )}
    </div>
  );
}

export default function App() {
  const { isRecording, isProcessing, privacyMode, togglePrivacy, initListeners, loadLanguage, theme, toggleTheme, initTheme, lastError, clearLastError } = useAppStore();
  const location = useLocation();
  const scrollRef = useRef<HTMLElement>(null);
  // A new page starts at the top (a #section link scrolls itself into view after).
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [location.pathname]);
  const plugRef = useRef<AnimatedIconHandle>(null);
  const ghostRef = useRef<AnimatedIconHandle>(null);
  const bugRef = useRef<AnimatedIconHandle>(null);

  // First-run onboarding wizard: shown until the user finishes/skips it once.
  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    getSetting("onboarding_done")
      .then((v) => setShowOnboarding(v !== "true"))
      .catch(() => {});
  }, []);

  useEffect(() => {
    initTheme();

    // Tell the backend whether a text box has focus in this window, so a dictation
    // made while LocalFlow is in front only counts as pasted if it had somewhere to go.
    const isTextTarget = (el: Element | null) => {
      if (!el) return false;
      if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
      if (el instanceof HTMLInputElement) {
        const textual = ["text", "search", "email", "url", "tel", "password", "number", ""];
        return textual.includes(el.type) && !el.readOnly && !el.disabled;
      }
      return (el as HTMLElement).isContentEditable === true;
    };
    const reportFocus = () =>
      invoke("set_text_focus", { focused: isTextTarget(document.activeElement) }).catch(() => {});
    const onFocusOut = () => setTimeout(reportFocus, 0);
    document.addEventListener("focusin", reportFocus);
    document.addEventListener("focusout", onFocusOut);
    reportFocus();
    let cleanup: (() => void) | null = null;
    initListeners().then((fn) => {
      cleanup = fn;
    });
    loadLanguage();
    return () => {
      cleanup?.();
      document.removeEventListener("focusin", reportFocus);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [initListeners, loadLanguage, initTheme]);

  // While incognito is on, keep the ghost gently jumping on a loop. The icon's own
  // animation runs ~1.2s, so re-trigger a touch after that for a seamless loop.
  useEffect(() => {
    if (!privacyMode) return;
    ghostRef.current?.startAnimation();
    const id = setInterval(() => ghostRef.current?.startAnimation(), 1300);
    return () => {
      clearInterval(id);
      ghostRef.current?.stopAnimation();
    };
  }, [privacyMode]);

  useEffect(() => {
    const handleMouseNavigate = (e: MouseEvent) => {
      // e.button === 3: Back/Button 4, e.button === 4: Forward/Button 5
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("mousedown", handleMouseNavigate, true);
    window.addEventListener("mouseup", handleMouseNavigate, true);
    return () => {
      window.removeEventListener("mousedown", handleMouseNavigate, true);
      window.removeEventListener("mouseup", handleMouseNavigate, true);
    };
  }, []);

  // Readiness: the app can only dictate with a downloaded model AND a microphone.
  // We poll lightly so the pill reflects changes made on the Models/Settings pages.
  const [notReadyReason, setNotReadyReason] = useState<string | null>(null);
  // Setup reminders (sidebar): shown until the user completes each step. Tracked
  // independently so finishing one (e.g. downloading a model) clears only that reminder.
  const [needModel, setNeedModel] = useState(false);
  // Newer version on the website: checked at launch and every 6 hours.
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  useEffect(() => {
    const check = () => checkUpdate().then((u) => setUpdateVersion(u.available ? u.latest : null)).catch(() => {});
    const first = setTimeout(check, 8000);
    const every = setInterval(check, 6 * 60 * 60 * 1000);
    return () => { clearTimeout(first); clearInterval(every); };
  }, []);
  const [needFormatting, setNeedFormatting] = useState(false);
  useEffect(() => {
    let active = true;
    const checkReady = async () => {
      try {
        const [models, devices, cli, llmModels, llmEnabled, perms] = await Promise.all([
          listModels(),
          listAudioDevices(),
          isLlamaCliInstalled(),
          listLlmModels(),
          getSetting("llm_enabled"),
          getPermissionStatus(),
        ]);
        if (!active) return;
        const hasDownloadedModel = models.some((m) => m.downloaded);
        const hasActiveModel = models.some((m) => m.downloaded && m.is_active);
        const hasMic = devices.length > 0;
        // On macOS the app also needs Microphone + Accessibility (to record and to
        // paste). Without them dictation can't work, so the pill must read "Not ready".
        let reason: string | null = null;
        if (!hasDownloadedModel) reason = "No speech model. Download one to start.";
        else if (!hasActiveModel) reason = "Choose an active speech model";
        else if (perms.is_macos && !perms.microphone) reason = "Allow microphone access";
        else if (!hasMic) reason = "No microphone detected";
        else if (perms.is_macos && !perms.accessibility)
          reason = "Grant Accessibility to type text";
        setNotReadyReason(reason);

        setNeedModel(!hasActiveModel);
        // Formatting is optional. Remind only users who turned it on but have not
        // finished installing its local helper/model.
        const hasLlmModel = llmModels.some((m) => m.downloaded);
        const formattingReady = llmEnabled === "true" && cli && hasLlmModel;
        setNeedFormatting(llmEnabled === "true" && !formattingReady);
      } catch {
        /* backend not up yet — don't flag a false error */
      }
    };
    checkReady();
    const id = setInterval(checkReady, 5000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  // Four visually distinct states: recording (mic on) · processing · ready · not ready.
  const statusState: "recording" | "processing" | "notready" | "ready" = isRecording
    ? "recording"
    : isProcessing
    ? "processing"
    : notReadyReason
    ? "notready"
    : "ready";
  const statusLabel = {
    recording: "Recording",
    processing: "Processing",
    notready: "Not ready",
    ready: "Ready",
  }[statusState];
  const readinessTarget = notReadyReason?.toLowerCase().includes("model") ? "/models" : "/settings";
  // Where "Fix it" takes you: the exact place that fixes it, or nowhere if nothing does.
  const errorTarget = (() => {
    const e = lastError?.toLowerCase() ?? "";
    if (e.includes("model")) return "/models";
    if (e.includes("speech was detected") || e.includes("microphone")) return "/settings#audio";
    if (e.includes("accessibility") || e.includes("type into")) return "/settings#permissions";
    return null;
  })();

  return (
    <div className="mac-window">
      <aside className="mac-sidebar">
        {/* Oil theme only: painted sky behind the sidebar. The sun sets on the right and
            the moon rises on the left when switching light/dark (see oil.css). */}
        <div className="oil-scene" aria-hidden="true">
          <div className="oil-sky day" />
          <div className="oil-sky night" />
          <div className="oil-sun" />
          <div className="oil-moon" />
          <div className="oil-hills day" />
          <div className="oil-hills night" />
          <div className="oil-grain" />
        </div>


        <div className="brand-lockup">
          <div className="brand-icon">
            <img src={theme === "dark" ? logoWhite : logoIcon} alt="LocalFlow" style={{ width: 27, height: 27, objectFit: "contain" }} />
          </div>
          <div className="brand-title">
            <strong className="wordmark">LocalFlow</strong>
            <span>On device transcription</span>
          </div>
        </div>

        <nav className="source-list" aria-label="Primary">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `source-item ${isActive ? "active" : ""} ${
                  item.to === "/settings" && notReadyReason ? "needs-setup" : ""
                }`
              }
              end={item.to === "/"}
            >
              {({ isActive }) => (
                <>
                  {"animated" in item ? (
                    <LoopingIcon icon={item.animated} active={isActive} strokeWidth={2} />
                  ) : (
                    <item.icon strokeWidth={2} />
                  )}
                  <span>{item.label}</span>
                </>
              )}
            </NavLink>
          ))}

          <SetupReminders needModel={needModel} needFormatting={needFormatting} updateVersion={updateVersion} />
        </nav>

        <div className="sidebar-footer">
          {/* Opened through the opener plugin, not a plain link: a target="_blank"
              here would navigate the settings webview itself and strand the user. */}
          <div className="report-row">
            <button
              type="button"
              className="theme-toggle report-bug"
              onClick={() => openUrl(BUG_REPORT_URL).catch(console.error)}
              onMouseEnter={() => bugRef.current?.startAnimation()}
              onMouseLeave={() => bugRef.current?.stopAnimation()}
              title="Found a bug? Tell me about it"
              aria-label="Report a bug"
            >
              <BugIcon ref={bugRef} size={15} />
              <span>Report</span>
            </button>
            <button
              type="button"
              className="built-by"
              onClick={() => openUrl("https://Aryab.in").catch(console.error)}
              title="Aryab.in"
            >
              built by&nbsp;<strong>Arya</strong>
            </button>
          </div>
          <button
            type="button"
            className="theme-toggle"
            onClick={() => invoke("quit_app").catch(console.error)}
            onMouseEnter={() => plugRef.current?.startAnimation()}
            onMouseLeave={() => plugRef.current?.stopAnimation()}
            title="Quit LocalFlow completely"
            aria-label="Quit app"
          >
            <PlugConnectedIcon ref={plugRef} size={15} />
            <span>Quit App</span>
          </button>
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label="Toggle color theme"
          >
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
          </button>
          <button
            type="button"
            className="theme-toggle"
            onClick={togglePrivacy}
            onMouseEnter={() => { if (!privacyMode) ghostRef.current?.startAnimation(); }}
            onMouseLeave={() => { if (!privacyMode) ghostRef.current?.stopAnimation(); }}
            title={privacyMode ? "Incognito on, nothing is saved" : "Turn on incognito mode"}
            aria-label="Toggle incognito mode"
            aria-pressed={privacyMode}
            style={privacyMode ? { color: "var(--accent)", borderColor: "var(--accent)" } : undefined}
          >
            <GhostIcon ref={ghostRef} size={15} />
            <span>{privacyMode ? "Incognito: On" : "Incognito mode"}</span>
          </button>
          <Link
            to={notReadyReason ? readinessTarget : "/"}
            className={`status-pill state-${statusState}`}
            title={notReadyReason ?? undefined}
            aria-label={notReadyReason ? `${statusLabel}: ${notReadyReason}. Open setup.` : statusLabel}
          >
            <span className="status-wave" aria-hidden="true">
              <i /><i /><i /><i />
            </span>
            <span className="status-pill-text">
              <span>{statusLabel}</span>
              {statusState === "notready" && notReadyReason && (
                <span className="status-sub">{notReadyReason}</span>
              )}
            </span>
            {privacyMode && <Shield size={14} color="var(--warning)" style={{ marginLeft: "auto" }} />}
          </Link>
        </div>
      </aside>

      <section className="mac-main">
        {lastError && (
          <div className="app-error-banner" role="alert">
            <span className="app-error-icon"><CircleAlert size={16} /></span>
            <span className="app-error-text">{lastError}</span>
            {errorTarget ? (
              <Link to={errorTarget} className="app-error-fix" onClick={clearLastError}>
                {errorTarget === "/settings#audio" ? "Check microphone" : errorTarget === "/models" ? "Open Language Model" : "Fix it"}
              </Link>
            ) : <span />}
            <button type="button" onClick={clearLastError} aria-label="Dismiss error">
              <X size={15} />
            </button>
          </div>
        )}

        <main className="page-scroll" ref={scrollRef}>
          {/* Keyed by page so each one fades in when you switch. */}
          <div key={location.pathname} className="route-view">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/shortcuts" element={<ShortcutsPage />} />
            {/* The dictionary now lives in Formatting options. */}
            <Route path="/dictionary" element={<Navigate to="/llm" replace />} />
            <Route path="/tips" element={<TipsPage />} />
            <Route path="/models" element={<ModelsPage />} />
            <Route path="/llm" element={<LLMSettingsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/about" element={<AboutPage />} />
          </Routes>
          </div>
        </main>
      </section>

      <ThemeTransitionOverlay />
      {showOnboarding && <OnboardingWizard onClose={() => setShowOnboarding(false)} />}
    </div>
  );
}
