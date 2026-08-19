# Security Policy

## Supported versions

LocalFlow is pre-1.0. Only the **latest release** receives security fixes.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through either of these:

- GitHub's [private vulnerability reporting](https://github.com/aryabysani/LocalFlow-OSS/security/advisories/new)
  (the **Security** tab → **Report a vulnerability**)
- The contact form at <https://localflow.aryab.in/contact>

Please include what you found, how to reproduce it, which OS and LocalFlow version
you were on, and what an attacker could do with it. A proof of concept helps a lot.

I will acknowledge your report within **7 days** and aim to ship a fix or give you a
timeline within **30 days**. This is a solo side project, not a funded product — I
will be honest with you about timelines rather than let a report go quiet.

If you would like credit in the release notes, say so and I will name you.

## What counts as a vulnerability here

LocalFlow is an offline desktop app, so the threat model is unusual. Things I
especially want to hear about:

- **Anything that leaves the machine.** Audio, transcripts, history, dictionary
  entries, or usage data reaching the network is a critical bug, not a feature.
- **Transcript or history leaking** to another local user, another application, or
  a world-readable file.
- **Text injection going somewhere unintended** — the wrong window, a lock screen,
  or a password field.
- **Model download integrity** — anything letting an attacker substitute a model or
  a `llama-cli` binary that LocalFlow then executes.
- **Privilege escalation** through the macOS Accessibility or Input Monitoring
  permissions the app holds, which are powerful and worth scrutiny.
- **Local privilege issues** in the SQLite database or the app-support directory.

## What does not count

- The macOS Gatekeeper warning and the Windows SmartScreen warning on unsigned
  builds. These are known and documented in [MAC_INSTALL.md](MAC_INSTALL.md); code
  signing certificates cost money this project does not currently have.
- Vulnerabilities in a model you chose to download from a third party.
- Attacks requiring an attacker who already has full control of the user account —
  at that point they can read the microphone directly.

## What LocalFlow does with your data

Stated plainly, because it is the whole point of the project:

- Audio is held **in memory only**, never written to disk, and freed after
  transcription.
- Transcripts are stored in a local SQLite database under your own user account,
  and can be cleared from **History** at any time.
- Incognito mode records nothing at all.
- There is no telemetry, no analytics, no crash reporting, and no account.
- The only network requests LocalFlow ever makes are model and binary downloads
  that **you** start from the Language Model or Formatting options pages.

The macOS entitlements file documents what the app deliberately never asks for:
camera, location, screen recording, contacts, photos, and calendar.
