# Contributing to LocalFlow

Thanks for wanting to help. LocalFlow is a small project, so there is no heavy
process here — but a few notes will save you time.

## Ground rule: it stays local

LocalFlow's whole reason to exist is that **your voice and your text never leave your
machine**. Any change that sends user audio, transcripts, usage statistics, crash
reports, or identifiers over the network will be declined, however useful it is.

Downloading a model or a release binary when the user explicitly asks for it is fine.
Anything that phones home on its own is not.

## Before you start

For anything bigger than a typo, **open an issue first**. It is much better to hear
"I'd rather solve that a different way" before you have written the code than after.

Good first contributions:

- Bug reports with real reproduction steps (genuinely the most valuable thing here)
- Dictionary and cleanup fixes — wrong filler removal, mangled punctuation
- Documentation, especially for non-developers trying to install the app
- Accessibility and keyboard-navigation fixes

## Setting up a dev environment

You need Node 20+, pnpm, and a Rust toolchain. Platform-specific prerequisites
(Xcode command-line tools on macOS, the MSVC build tools and the Vulkan SDK on
Windows) are listed under **Option B — Build it yourself** in the [README](README.md).

```bash
pnpm install
```

```bash
pnpm tauri dev
```

The first build compiles whisper.cpp from source and takes roughly ten minutes.
Later builds are incremental and quick. Be aware that `src-tauri/target/` grows to
several gigabytes; `cargo clean` reclaims it whenever you need the space.

## Running the checks

Please run these before opening a pull request:

```bash
pnpm build
```

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

CI runs the same three on every pull request.

## Layout

| Where | What |
|---|---|
| `src/routes/` | One file per page of the settings window |
| `src/windows/MicBubble.tsx` | The floating mic overlay |
| `src/lib/ipc.ts` | Typed wrappers around every Tauri command |
| `src-tauri/src/whisper.rs` | Speech-to-text |
| `src-tauri/src/cleanup.rs` | Filler removal, punctuation, spoken commands |
| `src-tauri/src/inject.rs` | Typing text into the focused app |
| `src-tauri/src/hook_*.rs` | Global hotkeys, split per platform |

Two areas have design notes worth reading before you change them:

- [`docs/self-correction.md`](docs/self-correction.md) — how spoken corrections are
  classified, and why some of it is deliberately regex rather than the LLM.
- The module headers in `inject.rs` and `hook_macos.rs` — macOS quirks are documented
  inline, and they exist because something broke.

## Style

Match the code already around you rather than any external style guide.

- Rust: `cargo fmt`, and prefer returning `Result<_, String>` from commands like the
  existing ones do.
- TypeScript: no `any` in new code, and keep `ipc.ts` in step with the Rust command
  signatures — it is the only thing keeping the two halves honest.
- Comments should explain *why*, not restate the code. The existing comments about
  App Nap, realtime audio threads, and Whisper's decoder are the model.

## Pull requests

Keep them focused — one concern per PR. Say what you changed, why, and how you
tested it on which platform. If you could only test on one OS, say so; that is
useful information, not a failing.

Commits use [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`), matching the existing history.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Licence

Contributions are accepted under the [MIT Licence](LICENSE), the same terms as the
rest of the project.
