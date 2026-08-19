## What does this change?

<!-- A sentence or two. If it fixes an issue, write "Fixes #123". -->

## Why?

<!-- What problem does this solve? Link the issue discussion if there was one. -->

## How was it tested?

<!-- Be specific. "Dictated 20 sentences on macOS 15 with large-v3-turbo" beats "works fine". -->

- [ ] macOS
- [ ] Windows
- [ ] Could not test on the other platform

## Checklist

- [ ] `pnpm build` passes
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml --check` passes
- [ ] New Tauri commands are mirrored in `src/lib/ipc.ts`
- [ ] No new network calls, telemetry, or data leaving the machine
- [ ] Comments explain *why* where the reason is not obvious
