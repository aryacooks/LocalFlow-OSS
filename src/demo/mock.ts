// The website's live demo of the app: the real LocalFlow interface with the Tauri
// backend replaced by made-up data, so people can click around without installing.
// Nothing here runs in the real app. Built by `pnpm build:demo` (vite.demo.config.ts).
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

const VERSION = "0.1.25";

// ── Made-up data ─────────────────────────────────────────────────────────────

/** Small deterministic random so the demo looks the same on every visit. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function wordsPerDay() {
  const r = rng(7);
  const out = [];
  const today = new Date();
  for (let i = 119; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const skip = r() < (weekend ? 0.45 : 0.12);
    const words = skip ? 0 : Math.round((weekend ? 120 : 260) + r() * (weekend ? 300 : 900));
    out.push({
      date: d.toISOString().slice(0, 10),
      words,
      wpm: words ? Math.round(108 + r() * 34) : 0,
      dictations: words ? Math.max(1, Math.round(words / 31)) : 0,
    });
  }
  return out;
}

const DAYS = wordsPerDay();
// Today always has some words, so the "today" card isn't empty.
Object.assign(DAYS[DAYS.length - 1], { words: 412, wpm: 129, dictations: 14 });

const STATS = {
  total_words: 53081,
  words_today: 412,
  avg_wpm_7d: 125,
  wpm_recent: [131, 127, 125, 122],
  streak_days: 4,
  longest_streak: 33,
  total_dictations: 1736,
  time_saved_minutes: 885,
  words_per_day: DAYS,
  top_apps: [
    { app_name: "Claude", word_count: 26540, dictation_count: 870 },
    { app_name: "Google Chrome", word_count: 12208, dictation_count: 402 },
    { app_name: "Antigravity", word_count: 6900, dictation_count: 221 },
    { app_name: "ChatGPT", word_count: 6900, dictation_count: 214 },
    { app_name: "LocalFlow", word_count: 531, dictation_count: 18 },
    { app_name: "Slack", word_count: 2, dictation_count: 1 },
  ],
};

const LINES: [string, string, string][] = [
  ["Claude", "um so can you refactor this into a hook and like add tests for the edge cases", "Can you refactor this into a hook and add tests for the edge cases?"],
  ["Slack", "the deploy is live keep an eye on errors for the next hour", "The deploy is live. Keep an eye on errors for the next hour."],
  ["Google Chrome", "best autumn hikes near lake tahoe", "Best autumn hikes near Lake Tahoe"],
  ["Notes", "an apple hit my head can i invoice the tree for research", "An apple hit my head. Can I invoice the tree for research?"],
  ["Gmail", "hi sam uh the deck is attached let me know what you think", "Hi Sam, the deck is attached. Let me know what you think."],
  ["Claude", "explain this regex like i'm five", "Explain this regex like I'm five."],
  ["WhatsApp", "on my way grab a table by the window", "On my way! Grab a table by the window."],
  ["ChatGPT", "give me three names for a plant shop that are not puns", "Give me three names for a plant shop that are not puns."],
  ["Antigravity", "move the settings button to the top right and make it a bit rounder", "Move the settings button to the top right and make it a bit rounder."],
  ["Google Docs", "chapter two opens on a rainy tuesday in cambridge", "Chapter two opens on a rainy Tuesday in Cambridge."],
  ["Figma", "make the button a little rounder and try the gold", "Make the button a little rounder and try the gold."],
  ["Notion", "q3 goals ship the windows build then add more languages", "Q3 goals: ship the Windows build, then add more languages."],
  ["Claude", "what's the difference between a mutex and a semaphore in one paragraph", "What's the difference between a mutex and a semaphore, in one paragraph?"],
  ["Messages", "running ten minutes late sorry", "Running ten minutes late, sorry!"],
  ["Google Chrome", "weather in bangalore this weekend", "Weather in Bangalore this weekend"],
  ["Cursor", "fix the install steps in the readme", "Fix the install steps in the README."],
  ["Discord", "good game one more round", "Good game. One more round?"],
  ["Claude", "write a haiku about a laptop that only works offline", "Write a haiku about a laptop that only works offline."],
];

const HISTORY = LINES.map(([app, raw, cleaned], i) => {
  const t = new Date(Date.now() - (i * 47 + 6) * 60_000 - (i > 6 ? 86_400_000 : 0));
  const words = cleaned.split(/\s+/).length;
  return {
    id: 1000 - i,
    timestamp: t.toISOString(),
    app_name: app,
    app_exe: app,
    raw_text: raw,
    cleaned_text: cleaned,
    word_count: words,
    duration_secs: Math.max(1.4, words / 2.1),
    language: "en",
    formatted: true,
  };
});

const MODELS = [
  ["base.en", "Flow Lite", "ggml-base.en-q5_1.bin", 57, 160, "English. The smallest and lightest. Quick, with okay accuracy.", true, false],
  ["small.en", "Flow Classic", "ggml-small.en-q5_1.bin", 190, 310, "English. Light on memory with good accuracy for everyday use.", true, false],
  ["parakeet-tdt-v2", "Flow Swift", "parakeet/encoder.onnx", 661, 1100, "English. Our fastest and most accurate English model: text appears almost instantly and words are rarely dropped.", true, true],
  ["medium.en", "Flow Plus", "ggml-medium.en-q5_0.bin", 514, 660, "English. More accurate than Classic but slower.", false, false],
  ["large-v3-turbo", "Flow Multilingual", "ggml-large-v3-turbo-q5_0.bin", 874, 1000, "Hindi and 90+ other languages, and mixing them with English.", false, false],
  ["large-v3-q5", "Flow Multilingual Max", "ggml-large-v3-q5_0.bin", 1080, 1500, "Our most accurate model for Hindi, Telugu, Kannada and other languages, but several times slower.", false, false],
].map(([id, name, filename, size_mb, ram_mb, description, downloaded, is_active]) => ({
  id, name, filename, url: "", size_mb, ram_mb, description, downloaded,
  size_on_disk: downloaded ? (size_mb as number) * 1_048_576 : 0, is_active,
}));

const LLMS = [{
  id: "llama-3.2-1b", name: "Standard (Recommended)", filename: "Llama-3.2-1B-Instruct-Q4_K_M.gguf", url: "",
  size_mb: 702, description: "Recommended. Good cleanup quality and works well on most computers.",
  downloaded: true, size_on_disk: 702 * 1_048_576, is_active: true,
}];

let dictionary = [
  { id: 1, term: "LocalFlow", pronunciation: "local flow", replacement: "LocalFlow" },
  { id: 2, term: "Tauri", pronunciation: "tory", replacement: "Tauri" },
  { id: 3, term: "Arya", pronunciation: "aria", replacement: "Arya" },
];

const settings: Record<string, string> = {
  onboarding_done: "true",
  autostart_initialized: "true",
  save_history: "true",
  play_sounds: "true",
  track_apps: "true",
  show_bubble: "true",
  llm_enabled: "true",
  llm_active_model: "llama-3.2-1b",
  languages: JSON.stringify(["en"]),
  fn_trigger_key: "fn",
  bubble_orb: "orbit",
  mic_device: "MacBook Pro Microphone",
};

let privacy = false;
let history = [...HISTORY];

// ── The fake backend ─────────────────────────────────────────────────────────

function handle(cmd: string, a: Record<string, any> = {}): unknown {
  switch (cmd) {
    // app info + updates
    case "plugin:app|version": return VERSION;
    case "plugin:app|name": return "LocalFlow";
    case "plugin:app|tauri_version": return "2.12.5";
    case "check_update": return { current: VERSION, latest: VERSION, available: false, notes: null };
    case "install_update": return null;

    // settings
    case "get_setting": return settings[a.key] ?? null;
    case "set_setting": settings[a.key] = String(a.value); return null;
    case "get_all_settings": return { ...settings };

    // stats + history
    case "get_dashboard_stats": return STATS;
    case "get_history": {
      const q = String(a.search ?? "").toLowerCase();
      const list = q ? history.filter((h) => h.cleaned_text.toLowerCase().includes(q) || h.app_name.toLowerCase().includes(q)) : history;
      const off = a.offset ?? 0;
      return list.slice(off, off + (a.limit ?? 50));
    }
    case "delete_history_entry": history = history.filter((h) => h.id !== a.id); return null;
    case "clear_history": history = []; return null;
    case "get_app_icon": return null;
    case "get_system_stats": return {
      process_cpu: 0.2 + Math.random() * 0.4, process_memory_mb: 142, system_cpu: 9 + Math.random() * 6,
      system_memory_pct: 55, estimated_power_watts: 0.1, app_state: "idle", cpu_temp_c: 45, thermal_state: "nominal",
    };

    // dictionary + notes
    case "get_dictionary": return dictionary;
    case "add_dictionary_entry": {
      const id = Math.max(0, ...dictionary.map((d) => d.id)) + 1;
      dictionary = [...dictionary, { id, term: a.term, pronunciation: a.pronunciation, replacement: a.replacement }];
      return id;
    }
    case "delete_dictionary_entry": dictionary = dictionary.filter((d) => d.id !== a.id); return null;
    case "get_dictionary_prompt": return dictionary.map((d) => d.term).join(", ");
    case "get_notes": return [];

    // models
    case "list_models": return MODELS;
    case "list_llm_models": return LLMS;
    case "is_llama_cli_installed": return true;
    case "get_total_ram_mb": return 16384;
    case "download_model": case "download_llm_model": case "download_llama_cli":
    case "delete_model": case "delete_llm_model": case "cancel_download":
      throw new Error("Downloads are off in this demo. Get the app to try them.");
    case "set_active_model":
      MODELS.forEach((m) => (m.is_active = m.filename === a.filename));
      return null;

    // devices, permissions, placement
    case "list_audio_devices": return ["MacBook Pro Microphone", "AirPods Pro"];
    case "get_permission_status": return { is_macos: true, is_windows: false, microphone: true, accessibility: true, input_monitoring: true };
    case "get_install_status": return { is_macos: true, running_from_disk_image: false, app_translocated: false, needs_move_to_applications: false };
    case "get_notch_geometry": return { width: 200, height: 32, has_notch: true, screen_w: 1512, screen_h: 982 };
    case "get_bubble_placement": return ["bottom-right", 0, 0];
    case "get_nudge_range": return null;
    case "get_privacy_mode": return privacy;
    case "toggle_privacy_mode": privacy = !privacy; return privacy;
    case "get_foreground_app": return ["Claude", "Claude"];
    case "get_amplitude": return 0;
    case "is_recording": return false;
    case "capture_trigger_key": throw new Error("Changing the key needs the real app.");

    // plugins
    case "plugin:autostart|is_enabled": return true;
    case "plugin:opener|open_url": window.open(String(a.url ?? a.path ?? ""), "_blank", "noopener"); return null;
    case "quit_app": return null;
  }
  // Everything else (window moves, shortcuts, sounds…) just succeeds quietly.
  return null;
}

export function installDemoBackend() {
  mockWindows("main");
  mockIPC((cmd, payload) => handle(cmd, (payload ?? {}) as Record<string, any>), { shouldMockEvents: true });
}
