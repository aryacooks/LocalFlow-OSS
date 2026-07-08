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
