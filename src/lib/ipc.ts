import { invoke } from "@tauri-apps/api/core";

// Type-safe Tauri invoke wrappers

export async function getAmplitude() {
  return invoke<{ rms: number; bars: number[] }>("get_amplitude");
}

export async function startRecording(deviceName?: string) {
  return invoke<void>("start_audio_capture", { deviceName });
}

export async function stopRecording() {
  return invoke<number>("stop_audio_capture");
}

export async function transcribeAudio(language?: string, initialPrompt?: string) {
  return invoke<string>("transcribe_audio", { language, initialPrompt });
}

export async function listModels() {
  return invoke<ModelInfo[]>("list_models");
}

export async function downloadModel(modelId: string) {
  return invoke<string>("download_model", { modelId });
}

/** Cancel an in-flight download (Whisper model, LLM model, or "llama-cli"). */
export async function cancelDownload(modelId: string) {
  return invoke<void>("cancel_download", { modelId });
}

export async function setActiveModel(filename: string) {
  return invoke<void>("set_active_model", { filename });
}

export async function deleteModel(modelId: string) {
  return invoke<void>("delete_model", { modelId });
}

export async function getDashboardStats() {
  return invoke<DashboardStats>("get_dashboard_stats");
}

export async function getHistory(search?: string, limit?: number, offset?: number) {
  return invoke<DictationEntry[]>("get_history", { search, limit, offset });
}

export async function deleteHistoryEntry(id: number) {
  return invoke<void>("delete_history_entry", { id });
}

export async function clearHistory() {
  return invoke<void>("clear_history");
}

export async function getDictionary() {
  return invoke<DictionaryEntry[]>("get_dictionary");
}

export async function addDictionaryEntry(term: string, pronunciation: string, replacement: string) {
  return invoke<number>("add_dictionary_entry", { term, pronunciation, replacement });
}

export async function deleteDictionaryEntry(id: number) {
  return invoke<void>("delete_dictionary_entry", { id });
}

export async function getSetting(key: string) {
  return invoke<string | null>("get_setting", { key });
}

export async function setSetting(key: string, value: string) {
  return invoke<void>("set_setting", { key, value });
}

export async function getAllSettings() {
  return invoke<Record<string, string>>("get_all_settings");
}

export async function listAudioDevices() {
  return invoke<string[]>("list_audio_devices");
}

export async function setAudioDevice(deviceName: string) {
  return invoke<void>("set_audio_device", { deviceName });
}

export async function getNotes() {
  return invoke<Note[]>("get_notes");
}

export async function saveNote(id: string, title: string, content: string, folder: string) {
  return invoke<void>("save_note", { id, title, content, folder });
}

export async function deleteNote(id: string) {
  return invoke<void>("delete_note", { id });
}

export async function getForegroundApp() {
  return invoke<[string, string]>("get_foreground_app");
}

export async function togglePrivacyMode() {
  return invoke<boolean>("toggle_privacy_mode");
}

export async function setRomanize(romanize: boolean) {
  return invoke<void>("set_romanize", { romanize });
}

export async function setBubbleVisible(visible: boolean) {
  return invoke<void>("set_bubble_visible", { visible });
}

export async function setEarconsEnabled(enabled: boolean) {
  return invoke<void>("set_earcons_enabled", { enabled });
}

// Bounds for the manual bubble-size multiplier. Mirrored in Rust
// (`BUBBLE_SCALE_MIN`/`MAX` in lib.rs) — keep the three in sync.
export const BUBBLE_SCALE_MIN = 0.5;
export const BUBBLE_SCALE_MAX = 5.0;
export const BUBBLE_SCALE_STEP = 0.1;

// Manual size override for the floating bubble. Either "auto" or a scale
// multiplier as a string, e.g. "1.40". Rust clamps and normalises whatever it gets.
export async function setBubbleSize(size: string) {
  return invoke<void>("set_bubble_size", { size });
}

// Floating-bubble position. Stored as a fraction (0..1) of the available screen span;
// null means it's at the default bottom-right spot.
export async function getBubblePosition() {
  return invoke<[number, number] | null>("get_bubble_position");
}

// Move the bubble by a fractional step (D-pad). Returns the new [fx, fy].
export async function nudgeBubble(dx: number, dy: number) {
  return invoke<[number, number] | null>("nudge_bubble", { dx, dy });
}

export async function resetBubblePosition() {
  return invoke<void>("reset_bubble_position");
}

// ── macOS permissions (first-run onboarding) ──
export interface PermissionStatus {
  is_macos: boolean;
  is_windows: boolean;
  microphone: boolean;
  accessibility: boolean;
  input_monitoring: boolean;
}

export async function getPermissionStatus() {
  return invoke<PermissionStatus>("get_permission_status");
}

// Total physical RAM (MB) — used to recommend a Whisper model in onboarding.
export async function getTotalRamMb() {
  return invoke<number>("get_total_ram_mb");
}

export interface InstallStatus {
  is_macos: boolean;
  running_from_disk_image: boolean;
  app_translocated: boolean;
  needs_move_to_applications: boolean;
}

export async function getInstallStatus() {
  return invoke<InstallStatus>("get_install_status");
}

// Fires the macOS Accessibility prompt + adds the app to the list. Returns trust state.
export async function requestAccessibilityPermission() {
  return invoke<boolean>("request_accessibility_permission");
}

export async function requestInputMonitoringPermission() {
  return invoke<boolean>("request_input_monitoring_permission");
}

// Fires the macOS microphone prompt via AVFoundation (so the status refreshes after
// granting, without an app restart). Returns whether the mic is now authorized.
export async function requestMicrophonePermission() {
  return invoke<boolean>("request_microphone_permission");
}

// pane: "microphone" | "accessibility" | "input-monitoring"
export async function openPrivacySettings(pane: string) {
  return invoke<void>("open_privacy_settings", { pane });
}

// Types
export interface ModelInfo {
  id: string;
  name: string;
  filename: string;
  url: string;
  size_mb: number;
  ram_mb: number;
  description: string;
  downloaded: boolean;
  size_on_disk: number;
  is_active?: boolean;
}

export interface DashboardStats {
  total_words: number;
  words_today: number;
  avg_wpm_7d: number;
  streak_days: number;
  longest_streak: number;
  total_dictations: number;
  time_saved_minutes: number;
  words_per_day: WordsPerDay[];
  top_apps: AppUsage[];
}

export interface WordsPerDay {
  date: string;
  words: number;
  wpm: number;
  dictations: number;
}

export interface AppUsage {
  app_name: string;
  word_count: number;
  dictation_count: number;
}

export interface DictationEntry {
  id: number;
  timestamp: string;
  app_name: string;
  app_exe: string;
  raw_text: string;
  cleaned_text: string;
  word_count: number;
  duration_secs: number;
  language: string;
}

export interface DictionaryEntry {
  id: number;
  term: string;
  pronunciation: string;
  replacement: string;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  folder: string;
  created_at: string;
  updated_at: string;
}

export interface SystemStats {
  process_cpu: number;
  process_memory_mb: number;
  system_cpu: number;
  system_memory_pct: number;
  estimated_power_watts: number;
  app_state: string;
}

export async function getSystemStats() {
  return invoke<SystemStats>("get_system_stats");
}

export async function reloadGlobalShortcut() {
  return invoke<void>("reload_global_shortcut");
}

// LLM settings types and wrappers
export interface LlmModelInfo {
  id: string;
  name: string;
  filename: string;
  url: string;
  size_mb: number;
  description: string;
  downloaded: boolean;
  size_on_disk: number;
  is_active?: boolean;
}

export async function listLlmModels() {
  return invoke<LlmModelInfo[]>("list_llm_models");
}

export async function isLlamaCliInstalled() {
  return invoke<boolean>("is_llama_cli_installed");
}

export async function downloadLlamaCli() {
  return invoke<string>("download_llama_cli");
}

export async function downloadLlmModel(modelId: string) {
  return invoke<string>("download_llm_model", { modelId });
}

export async function deleteLlmModel(modelId: string) {
  return invoke<void>("delete_llm_model", { modelId });
}

// ── Transcription engine: Local or API (OpenRouter) ─────────────────────────
// The OpenRouter key is write-only from here: the backend never returns it, only
// whether one is set and a masked form for display.

export interface SttStatus {
  mode: "local" | "api";
  key_set: boolean;
  key_masked: string | null;
  /** Sum of what OpenRouter actually billed (its `usage.cost`), in USD. */
  total_cost_usd: number;
  total_seconds: number;
  api_dictations: number;
  model: string;
}

export const getSttStatus = () => invoke<SttStatus>("get_stt_status");
export const setSttMode = (mode: "local" | "api") => invoke<SttStatus>("set_stt_mode", { mode });
export const setOpenRouterKey = (key: string) => invoke<SttStatus>("set_openrouter_key", { key });
export const clearOpenRouterKey = () => invoke<SttStatus>("clear_openrouter_key");
export const resetApiUsage = () => invoke<SttStatus>("reset_api_usage");

/** Format a USD amount. Per-dictation costs are fractions of a cent, so small totals keep
 *  enough decimals to be non-zero; a plain `toFixed(2)` would read "$0.00" for weeks. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(5)}`;
}
