# LocalFlow — Project Guide

LocalFlow is a **local, on-device voice-to-text desktop app**. You press a hotkey, speak, and your words are transcribed by Whisper (running locally) and typed into whatever app is focused. An optional local LLM (llama.cpp) cleans up the text. Nothing leaves the machine.

- **Stack:** Tauri 2.0 (Rust backend) + React 19 + TypeScript + Vite (frontend)
- **Platforms:** Windows and macOS (Apple Silicon)
- **Rust crate name:** `localflow_lib` / binary `flowlocal`
- **Version:** 0.1.0

---

## Top-level layout

```
flowlocal/
├── index.html              # Vite entry; mounts React
├── package.json            # Frontend deps + scripts (dev / build / tauri)
├── vite.config.ts          # Vite config
├── tsconfig.json           # TypeScript config
├── components.json         # shadcn/ui config
├── README.md
├── src/                    # Frontend (React/TS) — the two app windows live here
├── src-tauri/              # Backend (Rust) — Tauri shell, all native logic
├── public/                 # Static assets served as-is
├── dist/                   # Vite build output (generated)
└── pics/                   # Design-source assets (gradients, mockups)
```

Build/run scripts (`package.json`): `npm run dev` (Vite only), `npm run tauri dev` (full app),
`npm run tauri build` (produces installers under `src-tauri/target/release/bundle/`).

---

## Frontend — `src/`

The app renders **two separate windows** (configured in `src-tauri/tauri.conf.json`):
the **main settings window** (`label: "main"`, 1100px wide) and the **floating mic bubble**
(`label: "bubble"`, transparent 240px overlay).

```
src/
├── main.tsx                # React root; renders App or MicBubble based on window
├── App.tsx                 # Main window: sidebar nav + react-router routes
├── windows/
│   └── MicBubble.tsx       # The floating, borderless, transparent mic overlay
│                           #   (bottom-right; idle glyph → recording bars → done text)
├── ThemeTransitionOverlay.tsx # Animated overlay for light/dark theme switches
├── windows/
│   └── MicBubble.tsx       # (listed above)
├── components/
│   ├── OnboardingWizard.tsx  # First-run wizard: mic/accessibility permissions + setup
│   └── ui/                 # shadcn/ui primitives
├── routes/                 # One file per page in the main window
│   ├── Dashboard.tsx       # "/"          — usage stats / workspace overview
│   ├── History.tsx         # "/history"   — past dictations
│   ├── Shortcuts.tsx       # "/shortcuts" — hotkey config
│   ├── Models.tsx          # "/models"    — Whisper model download/select ("Language Model")
│   ├── LLMSettings.tsx     # "/llm"       — LLM cleanup setup ("Formatting options")
│   ├── Settings.tsx        # "/settings"  — general settings (incl. launch-at-login toggle)
│   ├── About.tsx           # "/about"
│   ├── Dictionary.tsx      # custom-word dictionary (component, not a top-nav route)
│   └── Notes.tsx           # notes feature (component, not a top-nav route)
├── lib/
│   ├── ipc.ts              # Type-safe wrappers around Tauri `invoke()` commands
│   ├── store.ts            # Zustand global state + Tauri event listeners
│   └── utils.ts            # `cn()` Tailwind class-merge helper
├── assets/brand/           # Logo PNGs (logo_icon, logo_white, logo_full, logo_icon_square)
├── styles/globals.css      # Tailwind v4 + global styles, gradient banners, animations
└── vite-env.d.ts
```

**Sidebar nav order** (`App.tsx`): Dashboard · History · Shortcuts · Language Model ·
Formatting options · Settings · About.

Key frontend deps: `react-router-dom` v7 (routing), `zustand` (state), `radix-ui` +
`shadcn` + `lucide-react` (UI), `recharts` (Dashboard charts), `tailwindcss` v4.

---

## Backend — `src-tauri/`

```
src-tauri/
├── Cargo.toml / Cargo.lock         # Rust deps
├── build.rs                        # Build script
├── tauri.conf.json                 # Tauri config: windows, bundle targets, perms
├── Info.plist                      # macOS bundle metadata
├── entitlements.plist              # macOS entitlements (mic, accessibility)
├── .cargo/config.toml              # Cargo build flags
├── capabilities/                   # Tauri permission capability files
├── icons/                          # App icons
├── examples/whisper_smoke.rs       # Standalone Whisper smoke-test
└── src/
    ├── main.rs                     # Binary entry; calls into lib
    ├── lib.rs                      # App setup, command registration, core transcribe flow
    ├── pipeline.rs                 # Recording-pipeline state machine
    ├── audio.rs                    # Mic capture via cpal (16 kHz mono, 30s max)
    ├── whisper.rs                  # whisper-rs STT; model load + transcription
    ├── translit.rs                 # Devanagari (Hindi) → Latin romanization (Hinglish)
    ├── cleanup.rs                  # Text cleanup: LLM path w/ regex fallback
    ├── llm.rs                      # llama.cpp CLI mgmt (download/run local LLM)
    ├── inject.rs                   # Cross-platform text injection + foreground-app detect
    ├── earcon.rs                   # UI beeps (synthesized WAV; PlaySoundW / afplay)
    ├── db.rs                       # SQLite: dictation_history, dictionary, settings, style_memory
    ├── hook_windows.rs             # Windows global hotkey (WH_KEYBOARD_LL low-level hook)
    ├── hook_macos.rs               # macOS hotkeys via tauri-plugin-global-shortcut
    └── mac_permissions.rs          # TCC permission status (mic/accessibility) for onboarding;
                                    #   no-op-granted on non-macOS. Deep-links to Privacy panes.
```

Cross-platform launch-at-login is handled via `tauri-plugin-autostart` (wired up in
`lib.rs`; enabled by default on first run, toggled from Settings → Startup).

### How the pieces connect (request flow)
1. **Hotkey** (`hook_windows.rs` / `hook_macos.rs`) toggles recording.
2. **`audio.rs`** captures mic to a 16 kHz buffer; `MicBubble.tsx` polls `get_amplitude` for the live bars.
3. On stop, **`whisper.rs`** transcribes. If Hindi + romanize toggle on, **`translit.rs`** converts to Latin.
4. **`cleanup.rs`** (optionally via **`llm.rs`** llama.cpp) removes fillers / fixes text.
5. **`inject.rs`** types the result into the focused app; **`db.rs`** saves to history.
6. **`earcon.rs`** plays start/stop/done sounds throughout.

### Tauri commands (`#[tauri::command]`, ~45 total)
Frontend calls these via `invoke()` (see `src/lib/ipc.ts`). Grouped by module:
- **audio.rs:** `list_audio_devices`, `start_audio_capture`, `stop_audio_capture`, `get_amplitude`, `is_recording`
- **whisper.rs:** `list_models`, `download_model`, `transcribe_audio`, `set_active_model`, `delete_model`
- **db.rs:** `save_dictation`, `get_history`, `delete_history_entry`, `clear_history`, `get_dashboard_stats`, `get_dictionary`, `add_dictionary_entry`, `delete_dictionary_entry`, `get_dictionary_prompt`, `get_setting`, `set_setting`, `get_all_settings`, `get_notes`, `save_note`, `delete_note`
- **cleanup.rs:** `cleanup_text`, `command_mode_transform`
- **llm.rs:** `list_llm_models`, `is_llama_cli_installed`, `download_llama_cli`, `download_llm_model`, `delete_llm_model`
- **inject.rs:** `inject_text`, `inject_text_clipboard`, …
- **mac_permissions.rs:** `get_permission_status`, `request_accessibility_permission`, `open_privacy_settings`
- **pipeline.rs:** recording-state commands
- **lib.rs:** `start_recording_cmd`, `stop_and_transcribe_cmd`, `resize_bubble`, `open_main_window`, `quit_app`, …

---

## Conventions & notes
- **Platform split:** keyboard hooks are split into `hook_windows.rs` / `hook_macos.rs` via `cfg`. macOS-specific quirks (e.g. `osascript` for keystrokes instead of `enigo`) are documented inline in the relevant module headers — read those before touching injection or hooks.
- **Graceful degradation:** the LLM cleanup is optional; `cleanup.rs` falls back to regex when no model is loaded.
- **Spoken self-corrections:** the categories (replace-last / cancel / hedge / insertion), how to identify them, and the deliberate regex-vs-LLM split are documented in [`docs/self-correction.md`](docs/self-correction.md). Read it before touching correction logic in `cleanup.rs`.
- **Permissions & onboarding:** `mac_permissions.rs` + `OnboardingWizard.tsx` drive the first-run flow. On macOS the app needs Microphone **and** Accessibility (TCC) or it silently does nothing; on Windows it's a mic-only flow. Non-macOS builds report permissions as granted.
- **Launch at login:** on by default (`tauri-plugin-autostart`), initialized once via the `autostart_initialized` setting so re-enabling isn't forced if the user turns it off; user-toggleable in Settings → Startup.
- **Build artifacts** land in `src-tauri/target/release/bundle/` (`.dmg`/`.app` on macOS, `nsis` `.exe` + `.msi` on Windows). They are gitignored — distribute via GitHub Releases, not commits.
