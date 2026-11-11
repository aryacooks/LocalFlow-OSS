import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const IS_MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);

// macOS uses its own names for modifier keys. Bindings are stored in the cross-platform
// accelerator form ("Alt", "Meta", "Ctrl", "Win"); these are display-only mappings.
const MAC_KEY_NAMES: Record<string, string> = {
  Alt: "Option",
  Meta: "Cmd",
  Win: "Cmd",
  Cmd: "Cmd",
  Command: "Cmd",
  Ctrl: "Control",
  Control: "Control",
  Shift: "Shift",
};

/** Display a single key token with macOS names on macOS (e.g. "Alt" → "Option"). */
export function keyLabel(token: string): string {
  const t = token.trim();
  return IS_MAC ? MAC_KEY_NAMES[t] ?? t : t;
}

/** Display a full accelerator like "Alt+G" → "Option+G" on macOS. */
export function shortcutLabel(accel: string): string {
  return accel
    .split("+")
    .map((t) => keyLabel(t))
    .join("+");
}

// Vibrant mid-tone palette that stays legible on both light and dark themes.
const APP_PALETTE = [
  "#E8632A", "#3B82F6", "#10B981", "#8B5CF6", "#EF4444", "#F59E0B",
  "#14B8A6", "#EC4899", "#6366F1", "#22C55E", "#F97316", "#06B6D4",
];

/** Deterministic colour per app (by exe/bundle or name), so each app keeps its hue. */
export function appColor(key: string): string {
  const k = key.trim().toLowerCase();
  if (!k) return "#9aa0a6"; // neutral grey for unknown / untracked
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return APP_PALETTE[h % APP_PALETTE.length];
}
