# AGENTS.md — LocalFlow

Guidance for coding agents working in this repo. The full architecture map lives in
[`CLAUDE.md`](./CLAUDE.md) — **read it first**; this file only adds the practical, agent-facing
details (how to build, what to watch for, house style).

LocalFlow is a **local, on-device voice-to-text desktop app**: press a hotkey, speak, and Whisper
(running locally) transcribes and types the text into the focused app. An optional local LLM
(llama.cpp) cleans it up. Nothing leaves the machine.

- **Stack:** Tauri 2.0 (Rust) + React 19 + TypeScript + Vite
- **Platforms:** Windows and macOS (Apple Silicon)
- **Crate:** `localflow_lib` / binary `flowlocal` · **Version:** 0.1.0

---

## Build, run, and check

| Task | Command |
|------|---------|
| Frontend dev server only | `npm run dev` |
| Full app (Rust + web) | `npm run tauri dev` |
| Production installers | `npm run tauri build` → `src-tauri/target/release/bundle/` |
| Typecheck / lint frontend | `npm run build` (runs `tsc` + Vite build) |
| Rust check | `cargo check` (run in `src-tauri/`) |
| Rust format / lint | `cargo fmt` · `cargo clippy` (in `src-tauri/`) |

There is no automated test suite. Verification is manual; `src-tauri/examples/whisper_smoke.rs`
is a standalone Whisper smoke-test. The native pipeline (mic, hotkeys, injection) can only be
exercised through `npm run tauri dev` — a passing `cargo check` and `npm run build` is the most an
agent can confirm without a desktop session.

---

## Where things live (see `CLAUDE.md` for the full tree)

- **Frontend** — `src/`. Two windows: main settings window (`App.tsx` + `routes/`) and the floating
  mic overlay (`windows/MicBubble.tsx`). IPC wrappers in `src/lib/ipc.ts`, Zustand state in
  `src/lib/store.ts`. First-run flow in `src/components/OnboardingWizard.tsx`.
- **Backend** — `src-tauri/src/`. Entry in `lib.rs` (app setup + command registration). One module
  per concern: `audio` · `whisper` · `translit` · `cleanup` · `llm` · `inject` · `earcon` · `db` ·
  `pipeline` · `mac_permissions`, with platform-split hotkeys in `hook_windows.rs` / `hook_macos.rs`.

Request flow: hotkey → `audio` capture → `whisper` STT → (`translit` for Hindi) → `cleanup`
(optionally `llm`) → `inject` into focused app → `db` history, with `earcon` beeps throughout.

---

## Conventions agents must respect

- **Adding a Tauri command:** register it in `lib.rs`'s `invoke_handler`, then add a typed wrapper
  in `src/lib/ipc.ts`. Keep the two in sync — the frontend never calls `invoke()` directly.
- **Platform split:** anything OS-specific goes behind `cfg(target_os = ...)`. Keyboard hooks and
  injection differ per platform (macOS uses `osascript`/`enigo` quirks documented in the module
  headers — read them before touching `inject.rs` or the hooks).
- **Graceful degradation:** LLM cleanup is optional; `cleanup.rs` must keep working via its regex
  fallback when no model is loaded. Don't make LLM presence a hard requirement.
- **Permissions:** on macOS the app needs Microphone **and** Accessibility (TCC) or it silently does
  nothing; Windows is mic-only. Non-macOS builds report permissions as granted. `mac_permissions.rs`
  is the source of truth for status/deep-links.
- **UI:** React 19 + Tailwind v4 + shadcn/ui (`src/components/ui/`) + `lucide-react`. Reuse existing
  primitives and the gradient-banner/animation patterns in `src/styles/globals.css`; match the
  surrounding component style.
- **No secrets, no network egress for user data.** The whole premise is on-device — don't introduce
  telemetry or cloud calls. Model/CLI downloads (`whisper.rs`, `llm.rs`) are the only outbound traffic.
- **Build artifacts** in `src-tauri/target/` are gitignored — distribute via GitHub Releases, never commit them.

---

## Git & PR etiquette

- Branch off `master`; don't commit or push unless asked.
- Commit style follows the existing history: `type(scope): summary` (e.g. `feat(windows): …`,
  `design(dmg): …`). Keep messages present-tense and scoped.
- Releases are built by the cross-platform CI workflow (macOS universal `.dmg` + Windows `.exe`).
