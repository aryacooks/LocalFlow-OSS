# Changelog

All notable changes to LocalFlow are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/). While LocalFlow is
pre-1.0, minor breaking changes may land in patch releases.

## [Unreleased]

## [0.1.3] — 2026-08-19

### Added

- **Report bug** button in the sidebar, opening the contact form in your browser.
- Project documentation for contributors: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, issue and pull-request templates, and this changelog.
- Continuous integration on every pull request — frontend typecheck and build,
  plus Rust formatting and tests.

### Changed

- **Dictation no longer ends with a full stop.** Periods between sentences are kept,
  and a `?` or `!` is never touched. Say "period" or "full stop" if you want one at
  the end. Dictation usually lands in chat boxes and search fields, where a trailing
  period reads as stiff — and typing one is easier than deleting one.
- Removed the "Local only" badge from the title bar; the dashboard already says so.

### Fixed

- **Every dictation reloaded the speech model from disk.** With a 547 MB model that
  meant re-reading half a gigabyte before transcribing a single word. The model is
  now cached across dictations and reloaded only when you actually switch models.
- **Language auto-detection processed the entire recording.** Whisper only inspects
  the first 30 seconds to identify a language, so on a long recording most of that
  work was computed and discarded. It now reads only what the detector uses.
  Both fixes are most noticeable on multilingual models with Language set to Auto.

## [0.1.2] — 2026-08-10

### Fixed

- **Whisper repetition loops.** On recordings past roughly three minutes the decoder
  could latch onto a sentence and repeat it dozens of times. Added decoder guards and
  a pass that collapses repeated runs.
- **Filler removal ate meaningful words.** "ok right now" became "now". Filler is now
  judged per occurrence and by position, so words doing real work survive.
- **A full stop was appended after spoken "question mark" and "exclamation mark"**,
  producing "Are you sure?.".
- A temporary prompt file written for LLM cleanup was left behind when inference
  failed. It is now removed on every path via an RAII guard.
- Release builds produced no installers — `pnpm-workspace.yaml` was missing its
  `packages` field, so `pnpm install` failed outright in CI.
- macOS release builds failed at code signing when Apple secrets were absent. GitHub
  substitutes empty strings for undefined secrets, and an empty certificate still
  looked like a certificate to the bundler.

### Changed

- **Maximum recording length raised from 5 to 10 minutes.** Past that, the earliest
  audio is dropped rather than the recording stopping.
- The dashboard now aggregates by day, week, month, and year, and shows estimated
  time saved next to both the word count and the lifetime dictation total.
- Recording limits and the "longer audio takes longer to transcribe" caveat are now
  stated on the dashboard.
- History colours each source application distinctly.
- Redesigned the privacy section in Settings.

### Documentation

- `MAC_INSTALL.md` no longer contains a hardcoded local path, and its Gatekeeper
  steps now distinguish macOS 15 and later from macOS 14 and earlier.

## [0.1.1] — 2026-08-08

### Changed

- Clearer wording in the first-run permission screens.
- Documented in `entitlements.plist` that LocalFlow deliberately never requests
  camera, location, screen recording, contacts, photos, or calendar access.

## [0.1.0] — 2026-08-03

Initial public release.

- On-device speech-to-text with Whisper — no cloud, no account, no telemetry.
- Optional local LLM cleanup via llama.cpp, with a regex fallback when unavailable.
- Keyboard hotkeys, hold-to-talk, and mouse-button triggers.
- Text injected directly at the cursor in any application.
- Spoken punctuation and editing commands, including "scratch that" and
  self-corrections such as "meet at 6, no wait, 8".
- English and Hindi, with Hindi to Latin "Hinglish" romanization.
- Usage dashboard, searchable history, custom dictionary, and notes.
- Light and dark themes, floating mic bubble, launch at login.
- macOS (Apple Silicon) and Windows.

[Unreleased]: https://github.com/aryacooks/LocalFlow-OSS/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/aryacooks/LocalFlow-OSS/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/aryacooks/LocalFlow-OSS/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/aryacooks/LocalFlow-OSS/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/aryacooks/LocalFlow-OSS/releases/tag/v0.1.0
