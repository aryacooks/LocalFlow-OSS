import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Theme = "dark" | "light";
const THEME_KEY = "localflow-theme";

function readStoredTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

// Drives theming by toggling the `dark`/`light` class on <html>; CSS variables in
// globals.css key off `html.dark` (dark palette) vs `:root` defaults (light/cream).
function applyTheme(t: Theme) {
  const el = document.documentElement;
  el.classList.remove("dark", "light");
  el.classList.add(t);
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* ignore */
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || "Unknown error");
  const lower = raw.toLowerCase();
  if (lower.includes("model") && (lower.includes("not") || lower.includes("corrupt"))) {
    return "Your speech model is missing or incomplete. Open Language Model and download it again.";
  }
  if (lower.includes("microphone") || lower.includes("input device") || lower.includes("audio device")) {
    return "LocalFlow could not use the microphone. Check Permissions and Audio input in Settings.";
  }
  if (lower.includes("accessibility") || lower.includes("osascript") || lower.includes("paste")) {
    return "LocalFlow could not type into the focused app. Grant Accessibility access in Settings.";
  }
  if (lower.includes("no speech")) {
    return "No speech was detected. Try again and speak closer to the microphone.";
  }
  if (lower.includes("cancel")) return "Dictation cancelled.";
  if (
    lower.includes("download") ||
    lower.includes("network") ||
    lower.includes("http") ||
    lower.includes("connection") ||
    lower.includes("disk")
  ) {
    return `Download failed. Check your internet connection and free disk space, then try again. (${raw})`;
  }
  return raw;
}

interface AppState {
  isRecording: boolean;
  isProcessing: boolean;
  privacyMode: boolean;
  language: string;
  lastTranscript: { raw: string; cleaned: string } | null;
  lastError: string | null;
  amplitude: { rms: number; bars: number[] };
  theme: Theme;
  // When set, an overlay of `from`-theme pixels dissolves to reveal the new theme.
  themeTransition: { from: Theme; id: number } | null;
  // Active Whisper-model downloads: id → percent. Lives here (not in the Models page)
  // so progress survives navigating away — the backend keeps downloading regardless.
  modelDownloads: Record<string, number>;

  setIsRecording: (v: boolean) => void;
  setIsProcessing: (v: boolean) => void;
  setPrivacyMode: (v: boolean) => void;
  setLanguage: (v: string) => void;
  setLastTranscript: (t: { raw: string; cleaned: string } | null) => void;
  clearLastError: () => void;
  setAmplitude: (a: { rms: number; bars: number[] }) => void;

  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  initTheme: () => void;
  endThemeTransition: () => void;

  startModelDownload: (id: string) => Promise<void>;
  startLlmModelDownload: (id: string) => Promise<void>;
  startLlmCliDownload: () => Promise<void>;

  loadLanguage: () => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  togglePrivacy: () => Promise<void>;
  initListeners: () => Promise<() => void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  isRecording: false,
  isProcessing: false,
  privacyMode: false,
  language: "auto",
  lastTranscript: null,
  lastError: null,
  amplitude: { rms: 0, bars: Array(8).fill(0.1) },
  theme: readStoredTheme(),
  themeTransition: null,
  modelDownloads: {},

  setIsRecording: (v) => set({ isRecording: v }),
  setIsProcessing: (v) => set({ isProcessing: v }),
  setPrivacyMode: (v) => set({ privacyMode: v }),
  setLanguage: (v) => {
    set({ language: v });
    // Sync to the live pipeline AND persist so the choice survives restarts.
    invoke("set_language", { language: v }).catch(console.error);
    invoke("set_setting", { key: "language", value: v }).catch(console.error);
  },
  setLastTranscript: (t) => set({ lastTranscript: t }),
  clearLastError: () => set({ lastError: null }),
  setAmplitude: (a) => set({ amplitude: a }),

  setTheme: (t) => {
    applyTheme(t);
    set({ theme: t });
  },
  toggleTheme: () => {
    const from: Theme = get().theme;
    const next: Theme = from === "dark" ? "light" : "dark";

    // Reduced motion or animations turned off: swap instantly, no dissolve.
    if (prefersReducedMotion()) {
      applyTheme(next);
      set({ theme: next });
      return;
    }

    // Show the dissolve overlay (old-theme pixels) over the still-current theme, then
    // swap the underlying theme on the next frame so there's no flash before it covers.
    set((s) => ({ themeTransition: { from, id: (s.themeTransition?.id ?? 0) + 1 } }));
    requestAnimationFrame(() => {
      applyTheme(next);
      set({ theme: next });
    });
  },
  initTheme: () => {
    applyTheme(get().theme);
  },
  endThemeTransition: () => set({ themeTransition: null }),

  // Load the saved language at startup and push it to the backend pipeline.
  loadLanguage: async () => {
    try {
      const saved = await invoke<string | null>("get_setting", { key: "language" });
      // Only English/Hindi are supported now; migrate any older saved language to auto.
      const allowed = ["auto", "en", "hi"];
      const lang = saved && allowed.includes(saved) ? saved : "auto";
      if (lang !== saved) {
        invoke("set_setting", { key: "language", value: lang }).catch(console.error);
      }
      set({ language: lang });
      await invoke("set_language", { language: lang });
    } catch (e) {
      console.error("Failed to load saved language:", e);
    }
  },

  startRecording: async () => {
    try {
      await invoke("start_recording_cmd");
      set({ isRecording: true, lastError: null });
    } catch (e) {
      console.error("Start recording failed:", e);
      set({ isRecording: false, lastError: friendlyError(e) });
    }
  },

  stopRecording: async () => {
    try {
      set({ isProcessing: true, isRecording: false });
      await invoke("stop_and_transcribe_cmd");
    } catch (e) {
      console.error("Stop recording failed:", e);
      set({ isProcessing: false, lastError: friendlyError(e) });
    }
  },

  // Kick off (or no-op if already running) a model download. Tracked globally so it
  // keeps reporting progress after the Models page unmounts; the Rust command runs to
  // completion independently of this promise.
  startModelDownload: async (id) => {
    if (get().modelDownloads[id] !== undefined) return; // already downloading
    set((s) => ({ modelDownloads: { ...s.modelDownloads, [id]: 0 } }));
    try {
      await invoke("download_model", { modelId: id });
    } catch (e) {
      console.error("Model download failed:", e);
      set({ lastError: friendlyError(e) });
      throw e;
    } finally {
      set((s) => {
        const next = { ...s.modelDownloads };
        delete next[id];
        return { modelDownloads: next };
      });
    }
  },

  // LLM (formatting) downloads share the same global map + "download-progress" event
  // (their ids — the model id, and "llama-cli" for the helper — don't collide with the
  // Whisper model ids), so they likewise survive leaving the Formatting page.
  startLlmModelDownload: async (id) => {
    if (get().modelDownloads[id] !== undefined) return;
    set((s) => ({ modelDownloads: { ...s.modelDownloads, [id]: 0 } }));
    try {
      await invoke("download_llm_model", { modelId: id });
    } catch (e) {
      console.error("LLM model download failed:", e);
      set({ lastError: friendlyError(e) });
      throw e;
    } finally {
      set((s) => {
        const next = { ...s.modelDownloads };
        delete next[id];
        return { modelDownloads: next };
      });
    }
  },
  startLlmCliDownload: async () => {
    const CLI = "llama-cli"; // matches the id the backend emits for the helper download
    if (get().modelDownloads[CLI] !== undefined) return;
    set((s) => ({ modelDownloads: { ...s.modelDownloads, [CLI]: 0 } }));
    try {
      await invoke("download_llama_cli");
    } catch (e) {
      console.error("llama-cli download failed:", e);
      set({ lastError: friendlyError(e) });
      throw e;
    } finally {
      set((s) => {
        const next = { ...s.modelDownloads };
        delete next[CLI];
        return { modelDownloads: next };
      });
    }
  },

  togglePrivacy: async () => {
    const newMode = await invoke<boolean>("toggle_privacy_mode");
    set({ privacyMode: newMode });
  },

  initListeners: async () => {
    const unlisten1 = await listen("recording-started", () => {
      set({ isRecording: true, lastError: null });
    });
    const unlisten2 = await listen("recording-stopped", () => {
      set({ isRecording: false });
    });
    const unlisten3 = await listen("processing-started", () => {
      set({ isProcessing: true });
    });
    const unlisten4 = await listen<{ raw?: string; cleaned?: string; error?: string }>(
      "processing-done",
      (event) => {
        set({ isProcessing: false });
        if (event.payload.error) {
          set({ lastError: friendlyError(event.payload.error) });
          return;
        }
        if (event.payload.cleaned) {
          set({
            lastError: null,
            lastTranscript: {
              raw: event.payload.raw || "",
              cleaned: event.payload.cleaned,
            },
          });
        }
      }
    );
    // Keep incognito (privacy) state in sync when toggled from the bubble or tray.
    const unlisten5 = await listen<boolean>("privacy-changed", (event) => {
      set({ privacyMode: event.payload });
    });
    // Global model-download progress — captured here (App-level) so it persists across
    // page navigation. Only update ids we consider active so stray events are ignored.
    const unlisten6 = await listen<{ id: string; progress: number }>(
      "download-progress",
      (event) => {
        set((s) => {
          if (s.modelDownloads[event.payload.id] === undefined) return s;
          return {
            modelDownloads: { ...s.modelDownloads, [event.payload.id]: event.payload.progress },
          };
        });
      }
    );

    return () => {
      unlisten1();
      unlisten2();
      unlisten3();
      unlisten4();
      unlisten5();
      unlisten6();
    };
  },
}));
