import { invoke } from "@tauri-apps/api/core";

// Type-safe Tauri invoke wrappers

export async function getAmplitude() {
  return invoke<{ rms: number; bars: number[]; level: number; bands: number[] }>("get_amplitude");
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

/** The app's icon as a PNG data URL (macOS), or null. */
export async function getAppIcon(appName: string, appExe: string) {
  return invoke<string | null>("get_app_icon", { appName, appExe });
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

/** Settings → Remove LocalFlow (src-tauri/src/uninstall.rs). */
export type RemoveChoice = "app_and_data" | "app_only" | "data_only";
export interface RemovalOutcome { data_deleted: boolean; app_removed: boolean; error: string | null }
export interface RemovalSupport { app_removable: boolean; reason: string | null }
export const removalSupport = () => invoke<RemovalSupport>("removal_support");
export const removeLocalflow = (choice: RemoveChoice) => invoke<RemovalOutcome>("remove_localflow", { choice });

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

/** Choose the start/stop sound set; the backend plays its start cue as a preview. */
export type BubbleMode = "screen" | "notch" | "off";

/** The Animation switch: floating orb, notch island (macOS), or nothing. */
export async function setBubbleMode(mode: BubbleMode) {
  return invoke<void>("set_bubble_mode", { mode });
}

export interface NotchGeometry {
  width: number;
  height: number;
  has_notch: boolean;
  screen_w: number;
  screen_h: number;
}

export async function getNotchGeometry() {
  return invoke<NotchGeometry>("get_notch_geometry");
}

export async function setSoundSet(id: string) {
  return invoke<void>("set_sound_set", { id });
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

/** The orb's spot (tl, tc, tr, ml, mr, bl, bc, br) and its left/right, up/down shift in points. */
export async function getBubblePlacement() {
  return invoke<[string, number, number]>("get_bubble_placement");
}

/** [minX, maxX, minY, maxY, screenW, screenH] in logical points for a spot. */
export async function getNudgeRange(spot: string) {
  return invoke<[number, number, number, number, number, number] | null>("get_nudge_range", { spot });
}

export async function setBubblePlacement(spot: string, nudge: number, nudgeY: number) {
  return invoke<void>("set_bubble_placement", { spot, nudge, nudgeY });
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
  /** WPM over the most recent 5%, 25%, 50% and 100% of dictations. */
  wpm_recent?: number[];
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
  /** Formatting options on for this dictation; null for entries from before this was recorded. */
  formatted: boolean | null;
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
  cpu_temp_c?: number | null;
  thermal_state?: string | null;
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

/** The languages the user speaks; auto-detect only picks among these. */
export async function setLanguages(languages: string[]) {
  return invoke<void>("set_languages", { languages });
}


// ── Updates (src-tauri/src/update.rs) ──
export interface UpdateStatus {
  /** Version running now. */
  current: string;
  /** Newest published version, if the check could read it. */
  latest: string | null;
  /** True when `latest` is newer than `current`. */
  available: boolean;
  notes: string | null;
}
export const checkUpdate = () => invoke<UpdateStatus>("check_update");
/** Downloads, verifies and installs; listen to "update-progress" for [downloaded, total|null]. */
export const installUpdate = () => invoke<void>("install_update");
