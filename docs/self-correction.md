# Spoken Self-Corrections — Design Notes

How LocalFlow turns spoken corrections into clean text ("meet at 6pm no wait at 8pm"
→ "meet at 8pm"), what the categories mean, how we identify them, and — most
importantly — where we deliberately do **nothing**, so cleanup never changes what you
meant.

This is the reference for the feature. When in doubt, the guiding rule is:
**the regex layer must be conservative and never wrong; the LLM layer is allowed to be
smart.**

---

## The four categories

### 1. Replace-last (the common case)
A value is spoken, then a correction cue, then the fix. The fix replaces the value.

- "hey mahesh lets meet at 6pm **no actually** at 8pm" → "…meet at 8pm"
- "let's meet at 6pm **— I mean** 8pm" → "…meet at 8pm"
- "let's meet at 6**, sorry,** 8" → "…meet at 8"
- "send it to bob **sorry,** to jim" → "send it to jim"

Key detail: keep whichever connector (at / to / on / …) is present, so you never get
"at at 8pm" or a dangling "to".

### 2. Full cancel / restart (scrap the clause, start over)
An explicit command to throw away what was just said.

- "let's meet at 6pm… **actually scratch that**, let's meet tomorrow instead"
- "send it to John — **no wait, forget that**, send it to Priya"
- "**delete everything I just said**, let's start over"

Pattern: `[clause] + scratch that / forget that / ignore that / never mind` → drop the
preceding clause. "start over" / "delete everything I just said" → clear the **whole**
buffer, not just one clause (different scope).

### 3. Soft hedge / walk-back (NOT a cancel — just thinking out loud)
The speaker softens or muses; there is no clean replacement.

- "let's meet at 6, **or, um, whatever works for you actually**"
- "call him — **or actually, maybe just text him**"

These are not clean replacements. Do **not** try to rewrite them. At most strip filler
and leave the words intact.

### 4. Insertion (adding a missed detail — NOT replacing)
The cue word adds information rather than undoing anything. **This is the main trap.**

- "let's meet at 6pm **— actually, at the usual cafe**" → keep BOTH (time *and* place)

"actually" here means "oh, and also" — not "undo". Deleting the "6pm" would be wrong.

---

## Trigger words to key off

```
no  /  no wait  /  no actually  /  actually no
actually  /  wait actually
i mean  /  i meant
sorry  /  my bad
scratch that  /  forget that  /  ignore that  /  never mind
or  /  or actually  /  or rather
```

⚠️ Trigger words alone are **not** enough to decide what to do. "actually" appears in
both a replacement (cat. 1) and an insertion (cat. 4). The word doesn't disambiguate —
what follows it does.

---

## How to identify which category you're in

One decision resolves all four cases: **look at what comes immediately after the trigger.**

```
see a trigger word
│
├─ explicit cancel phrase? ("scratch/forget/ignore that", "never mind",
│   "start over", "delete everything I just said")
│      → CANCEL: drop the preceding clause (or the whole buffer)
│
└─ otherwise, inspect what follows the trigger:
       │
       ├─ a new value of the SAME type as the value just before it
       │   (time→time, name→name, number→number)      → REPLACE-LAST  (cat. 1)
       │
       ├─ a value of a DIFFERENT type / a new dimension
       │   ("at 6pm — actually, at the cafe": time→place)  → INSERTION (cat. 4): keep both
       │
       └─ no concrete value (filler, "whatever works", "um")  → HEDGE (cat. 3): don't touch
```

**Design tip (the core heuristic):**
- trigger + a new value of the **same type** right after → **replace-last**
- trigger + a full **new clause** → **replace-clause / cancel**
- trigger + **no** new value immediately following → **don't touch anything**, just strip filler

The "actually" trap is solved by **type-matching**, not by the word:
`6pm … actually 8pm` is time→time (replace); `6pm … actually at the cafe` is time→place
(insert). Same trigger, opposite action.

---

## Why this can't all be regex

Regex can reliably detect **type** only for closed classes: times
(`\d+\s?(am|pm|:\d\d)`), bare numbers, maybe dates. It **cannot** know that "John" and
"Priya" are both names, or that "the cafe" is a place — that needs proper-noun / entity
recognition. So a pure-regex version:

- ✅ does time / number / clear-value replacements confidently, and
- ❌ **guesses wrong** on names, places, and insertion-vs-replacement.

That wrong guessing is exactly the "made it mean something else" failure we want to
avoid. This is why Wispr-Flow-style behavior uses an **LLM**, not rules — the
type-matching + intent classification above is a language-understanding task.

---

## The two-tier approach

### Tier 1 — regex (safe, conservative, always on)
Lives in [`src-tauri/src/cleanup.rs`](../src-tauri/src/cleanup.rs). Only the unambiguous
cases. Must never rewrite an insertion or a hedge.

- ✅ **Replace-last** for clear same-type values — **implemented**
  (`CORRECTION_COMPOUND_RE` + `CORRECTION_DELIMITED_RE`, see `resolve_corrections`).
  - Compound cues ("no wait", "no actually", "i mean", "or rather") match freely.
  - Single-word cues ("sorry", "no", "wait", "actually") fire **only** when a comma/dash
    hugs them on at least one side, so "I said no to him" / "I'm sorry about that" are
    left alone. Wrong value capped at 1–2 tokens so it can't swallow the verb.
- ✅ **Explicit clause cancel** — "scratch/delete/cancel/ignore that" — **implemented**
  (`CMD_DELETE_RE` in `apply_spoken_commands`). Candidate extensions: "forget that",
  "never mind".
- ◻️ **Full reset** — "start over" / "delete everything I just said" → clear the whole
  buffer. Not yet implemented.
- ❌ **Do NOT** auto-handle insertion-"actually", soft hedges, or name/place replacement
  in regex. For a bare hedge, at most strip filler.

### Tier 2 — LLM (the "real" Wispr Flow version)
The local llama.cpp cleanup path (optional, off by default). The prompt in
`build_cleanup_prompt` already resolves self-corrections. To make it match this design,
the prompt should state the type-matching rule explicitly:

> If the correction names a value of the **same kind**, replace it. If it **adds a new
> detail** of a different kind, keep both. If there is **no clear new value**, leave the
> text unchanged.

This gives insertion / hedge / name handling that regex fundamentally can't.

---

## Planned safe additions (Tier 1 TODO)

Both are low-ambiguity commands, so they belong in the conservative regex tier:

- ◻️ **Extend the clause-cancel handler** (`CMD_DELETE_RE` in `apply_spoken_commands`) to
  also catch **"forget that" / "ignore that" / "never mind"** alongside the existing
  "scratch/delete/cancel that". They're explicit commands → drop the preceding clause.
- ◻️ **Full reset** — **"start over" / "delete everything I just said"** → clear the
  **whole** buffer, not just one clause. Also unambiguous.

Reminder of the trap these must NOT touch: category 4 (insertion). "actually" often
*adds* a detail rather than undoing one — see "let's meet at 6pm — actually, at the usual
cafe". Only act on the explicit cancel/reset phrases, never on a bare trigger word.

---

## Full cleanup pipeline (summary with examples)

The order matters. Text flows through these stages between "you stop speaking" and "text
appears in the app". Stage 0 is transcription-level; stages 1+ are `cleanup.rs`.

| # | Stage | Where | What it does | Example |
|---|-------|-------|--------------|---------|
| 0 | **Non-speech + silence filter** | `whisper.rs` (`strip_non_speech`, RMS gate) | Drops `[BLANK_AUDIO]`, `(Clapping)`, `{music}`, lone `.`; skips near-silent clips | `(Clapping). hello` → `hello` |
| — | **Route** | `cleanup_text` | LLM path if enabled + installed, else regex fallback | — |
| 1 | **Self-corrections (replace-last)** | `resolve_corrections` | `<wrong> <cue> <right>` → `<right>`, keeping the connector | `meet at 6pm no wait at 8pm` → `meet at 8pm` |
| 2 | **Filler removal** | `FILLER_RE` | Strips um, uh, like, you know, i mean, actually, basically, literally, honestly, i think, … | `um so like it's fine` → `it's fine` |
| 3 | **Sentence casing** | `sentence_case` | Capitalizes sentence starts | `hello. how are you` → `Hello. How are you` |
| 4 | **Spoken commands** | `apply_spoken_commands` | Clause cancel + spoken punctuation/line breaks, then re-capitalize | see below |

**Stage 4 spoken commands in detail:**

| You say | You get |
|---|---|
| "let's meet at five **scratch that** let's meet at six" | "Let's meet at six" |
| "hello **comma** world **period**" | "Hello, world." |
| "line one **new line** line two" | "Line one⏎Line two" |
| "intro **new paragraph** body" | "Intro⏎⏎Body" |
| "are you sure **question mark**" | "Are you sure?" |
| "first **semicolon** second **colon** third" | "First; second: third" |

Supported spoken tokens: `new paragraph`, `new line` / `next line`, `question mark`,
`exclamation mark`/`point`, `full stop`, `semicolon`, `comma`, `period`, `colon`, and
`scratch/delete/cancel/ignore that`.

**Two separate commands in `cleanup.rs`:**
- `cleanup_text` — the dictation pipeline above (LLM or regex).
- `command_mode_transform` — transforms *already-selected* text by instruction
  ("make this a bullet list", "shorter", "more formal", "uppercase"). LLM if enabled,
  else basic rule-based transforms.

---

## Bottom line

- The regex layer's job is to be **conservative and never wrong**.
- The LLM layer's job is to be **smart**.
- Forcing the smart behavior into regex is what makes cleanup change your meaning — so
  we intentionally don't.
