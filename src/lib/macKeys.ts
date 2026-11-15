// macOS virtual keycodes (kVK_*) → how to show them. The primary key is stored as
// `key:<keycode>` in the `fn_trigger_key` setting (see hook_macos.rs).

const NAMES: Record<number, [name: string, short: string]> = {
  0: ["A", "A"], 11: ["B", "B"], 8: ["C", "C"], 2: ["D", "D"], 14: ["E", "E"], 3: ["F", "F"],
  5: ["G", "G"], 4: ["H", "H"], 34: ["I", "I"], 38: ["J", "J"], 40: ["K", "K"], 37: ["L", "L"],
  46: ["M", "M"], 45: ["N", "N"], 31: ["O", "O"], 35: ["P", "P"], 12: ["Q", "Q"], 15: ["R", "R"],
  1: ["S", "S"], 17: ["T", "T"], 32: ["U", "U"], 9: ["V", "V"], 13: ["W", "W"], 7: ["X", "X"],
  16: ["Y", "Y"], 6: ["Z", "Z"],
  29: ["0", "0"], 18: ["1", "1"], 19: ["2", "2"], 20: ["3", "3"], 21: ["4", "4"], 23: ["5", "5"],
  22: ["6", "6"], 26: ["7", "7"], 28: ["8", "8"], 25: ["9", "9"],
  27: ["Minus", "-"], 24: ["Equals", "="], 33: ["Left bracket", "["], 30: ["Right bracket", "]"],
  42: ["Backslash", "\\"], 41: ["Semicolon", ";"], 39: ["Quote", "'"], 43: ["Comma", ","],
  47: ["Period", "."], 44: ["Slash", "/"], 50: ["Backtick", "`"], 10: ["Section", "§"],
  36: ["Return", "↩"], 48: ["Tab", "⇥"], 49: ["Space", "Space"], 51: ["Delete", "⌫"],
  53: ["Esc", "esc"], 117: ["Forward delete", "⌦"],
  115: ["Home", "↖"], 119: ["End", "↘"], 116: ["Page up", "⇞"], 121: ["Page down", "⇟"],
  123: ["Left arrow", "←"], 124: ["Right arrow", "→"], 125: ["Down arrow", "↓"], 126: ["Up arrow", "↑"],
  122: ["F1", "F1"], 120: ["F2", "F2"], 99: ["F3", "F3"], 118: ["F4", "F4"], 96: ["F5", "F5"],
  97: ["F6", "F6"], 98: ["F7", "F7"], 100: ["F8", "F8"], 101: ["F9", "F9"], 109: ["F10", "F10"],
  103: ["F11", "F11"], 111: ["F12", "F12"], 105: ["F13", "F13"], 107: ["F14", "F14"], 113: ["F15", "F15"],
  106: ["F16", "F16"], 64: ["F17", "F17"], 79: ["F18", "F18"], 80: ["F19", "F19"], 90: ["F20", "F20"],
  63: ["Fn key", "Fn"],
  55: ["Left Command", "L⌘"], 54: ["Right Command", "R⌘"],
  56: ["Left Shift", "L⇧"], 60: ["Right Shift", "R⇧"],
  58: ["Left Option", "L⌥"], 61: ["Right Option", "R⌥"],
  59: ["Left Control", "L⌃"], 62: ["Right Control", "R⌃"],
  57: ["Caps Lock", "⇪"],
  114: ["Help", "Help"],
  65: ["Keypad .", "Num ."], 67: ["Keypad *", "Num *"], 69: ["Keypad +", "Num +"], 71: ["Keypad Clear", "Clear"],
  75: ["Keypad /", "Num /"], 76: ["Keypad Enter", "Enter"], 78: ["Keypad -", "Num -"], 81: ["Keypad =", "Num ="],
  82: ["Keypad 0", "Num 0"], 83: ["Keypad 1", "Num 1"], 84: ["Keypad 2", "Num 2"], 85: ["Keypad 3", "Num 3"],
  86: ["Keypad 4", "Num 4"], 87: ["Keypad 5", "Num 5"], 88: ["Keypad 6", "Num 6"], 89: ["Keypad 7", "Num 7"],
  91: ["Keypad 8", "Num 8"], 92: ["Keypad 9", "Num 9"],
};

/** Older setting values, from when the key was picked from a list. */
const LEGACY: Record<string, number> = { fn: 63, ropt: 61, rcmd: 54, rctrl: 62, lopt: 58, lctrl: 59 };

export const FN_KEYCODE = 63;
export const CAPS_LOCK_KEYCODE = 57;
export const ESC_KEYCODE = 53;

const MODIFIERS = new Set([63, 54, 55, 56, 60, 58, 61, 59, 62]);

export function isModifierKey(code: number) {
  return MODIFIERS.has(code);
}

/** Keycode named by a `fn_trigger_key` setting value; Fn when unset. */
export function triggerKeycode(setting: string | null | undefined): number {
  if (!setting) return FN_KEYCODE;
  const m = /^key:(\d+)$/.exec(setting);
  if (m) {
    const code = Number(m[1]);
    return code <= 127 && code !== CAPS_LOCK_KEYCODE ? code : FN_KEYCODE;
  }
  return LEGACY[setting] ?? FN_KEYCODE;
}

/** Display info for a keycode: full name, short keycap text, and the big glyph. */
export function macKey(code: number) {
  const [name, short] = NAMES[code] ?? [`Key ${code}`, `#${code}`];
  // Big glyph: the symbol without its L/R prefix ("R⌥" → "⌥").
  const cap = code === FN_KEYCODE ? "fn" : short.replace(/^[LR](?=[⌃-⌥⇧⌘])/, "");
  return { name, short, cap };
}
