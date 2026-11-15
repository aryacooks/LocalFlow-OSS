/** Languages Whisper's multilingual model can transcribe (whisper.cpp codes). */
export interface Lang {
  code: string;
  name: string;
  native?: string;
  indian?: boolean;
}

export const LANGUAGES: Lang[] = [
  // Indian languages first
  { code: "en", name: "English", indian: true },
  { code: "hi", name: "Hindi", native: "हिन्दी", indian: true },
  { code: "bn", name: "Bengali", native: "বাংলা", indian: true },
  { code: "te", name: "Telugu", native: "తెలుగు", indian: true },
  { code: "mr", name: "Marathi", native: "मराठी", indian: true },
  { code: "ta", name: "Tamil", native: "தமிழ்", indian: true },
  { code: "ur", name: "Urdu", native: "اردو", indian: true },
  { code: "gu", name: "Gujarati", native: "ગુજરાતી", indian: true },
  { code: "kn", name: "Kannada", native: "ಕನ್ನಡ", indian: true },
  { code: "ml", name: "Malayalam", native: "മലയാളം", indian: true },
  { code: "pa", name: "Punjabi", native: "ਪੰਜਾਬੀ", indian: true },
  { code: "as", name: "Assamese", native: "অসমীয়া", indian: true },
  { code: "ne", name: "Nepali", native: "नेपाली", indian: true },
  { code: "sd", name: "Sindhi", native: "سنڌي", indian: true },
  { code: "sa", name: "Sanskrit", native: "संस्कृतम्", indian: true },
  { code: "si", name: "Sinhala", native: "සිංහල", indian: true },
  // Everything else, A–Z
  ...([
    ["af", "Afrikaans"], ["sq", "Albanian"], ["am", "Amharic"], ["ar", "Arabic", "العربية"], ["hy", "Armenian"],
    ["az", "Azerbaijani"], ["ba", "Bashkir"], ["eu", "Basque"], ["be", "Belarusian"], ["bs", "Bosnian"],
    ["br", "Breton"], ["bg", "Bulgarian"], ["my", "Burmese"], ["yue", "Cantonese", "粵語"], ["ca", "Catalan"],
    ["zh", "Chinese", "中文"], ["hr", "Croatian"], ["cs", "Czech"], ["da", "Danish"], ["nl", "Dutch"],
    ["et", "Estonian"], ["fo", "Faroese"], ["fi", "Finnish"], ["fr", "French", "Français"], ["gl", "Galician"],
    ["ka", "Georgian"], ["de", "German", "Deutsch"], ["el", "Greek"], ["ht", "Haitian Creole"], ["ha", "Hausa"],
    ["haw", "Hawaiian"], ["he", "Hebrew"], ["hu", "Hungarian"], ["is", "Icelandic"], ["id", "Indonesian"],
    ["it", "Italian", "Italiano"], ["ja", "Japanese", "日本語"], ["jw", "Javanese"], ["kk", "Kazakh"], ["km", "Khmer"],
    ["ko", "Korean", "한국어"], ["lo", "Lao"], ["la", "Latin"], ["lv", "Latvian"], ["ln", "Lingala"],
    ["lt", "Lithuanian"], ["lb", "Luxembourgish"], ["mk", "Macedonian"], ["mg", "Malagasy"], ["ms", "Malay"],
    ["mt", "Maltese"], ["mi", "Maori"], ["mn", "Mongolian"], ["no", "Norwegian"], ["nn", "Nynorsk"],
    ["oc", "Occitan"], ["ps", "Pashto"], ["fa", "Persian", "فارسی"], ["pl", "Polish"], ["pt", "Portuguese", "Português"],
    ["ro", "Romanian"], ["ru", "Russian", "Русский"], ["sr", "Serbian"], ["sn", "Shona"], ["sk", "Slovak"],
    ["sl", "Slovenian"], ["so", "Somali"], ["es", "Spanish", "Español"], ["su", "Sundanese"], ["sw", "Swahili"],
    ["sv", "Swedish"], ["tl", "Tagalog"], ["tg", "Tajik"], ["tt", "Tatar"], ["th", "Thai", "ไทย"],
    ["bo", "Tibetan"], ["tr", "Turkish", "Türkçe"], ["tk", "Turkmen"], ["uk", "Ukrainian"], ["uz", "Uzbek"],
    ["vi", "Vietnamese", "Tiếng Việt"], ["cy", "Welsh"], ["yi", "Yiddish"], ["yo", "Yoruba"],
  ] as [string, string, string?][]).map(([code, name, native]) => ({ code, name, native })),
];

export const DEFAULT_LANGUAGES = ["en", "hi"];

export function langName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

/** Parse the stored "en,hi,ta" setting, keeping only known codes. */
export function parseLanguages(field: string | null | undefined): string[] {
  if (!field) return [...DEFAULT_LANGUAGES];
  const known = new Set(LANGUAGES.map((l) => l.code));
  const list = field.split(",").map((c) => c.trim()).filter((c, i, a) => known.has(c) && a.indexOf(c) === i);
  return list.length ? list : [...DEFAULT_LANGUAGES];
}
