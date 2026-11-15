import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Info, Plus, Search, X } from "lucide-react";
import { getSetting, setLanguages, setSetting } from "../lib/ipc";
import { LANGUAGES, Lang, parseLanguages } from "../lib/languages";
import { useAppStore } from "../lib/store";

/**
 * "Languages you speak" for the multilingual model. Chips for the chosen languages,
 * plus a searchable dropdown (Indian languages first). Auto-detect only picks among
 * the chosen ones; saved to the `languages` setting and pushed to the pipeline.
 */
export default function LanguagePicker() {
  const [chosen, setChosen] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);

  useEffect(() => {
    getSetting("languages").then((v) => setChosen(parseLanguages(v))).catch(console.error);
  }, []);

  // Close when clicking outside; focus the search box when opening.
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const save = async (next: string[]) => {
    if (next.length === 0) return; // always keep at least one
    setChosen(next);
    await setSetting("languages", next.join(","));
    await setLanguages(next);
    // A pinned language that's no longer in the list falls back to auto-detect.
    if (language !== "auto" && !next.includes(language)) setLanguage("auto");
  };

  const toggle = (code: string) =>
    save(chosen.includes(code) ? chosen.filter((c) => c !== code) : [...chosen, code]).catch(console.error);

  const q = query.trim().toLowerCase();
  const matches = (l: Lang) =>
    !q || l.name.toLowerCase().includes(q) || l.code === q || (l.native ?? "").toLowerCase().includes(q);
  const indian = useMemo(() => LANGUAGES.filter((l) => l.indian && matches(l)), [q]);
  const other = useMemo(() => LANGUAGES.filter((l) => !l.indian && matches(l)), [q]);

  const row = (l: Lang) => {
    const on = chosen.includes(l.code);
    const last = on && chosen.length === 1;
    return (
      <button
        key={l.code}
        type="button"
        className={`lang-option ${on ? "on" : ""}`}
        onClick={() => !last && toggle(l.code)}
        title={last ? "Keep at least one language" : undefined}
        aria-pressed={on}
      >
        <span className="lang-check">{on && <Check size={12} strokeWidth={3} />}</span>
        <span className="lang-name">{l.name}</span>
        {l.native && <span className="lang-native">{l.native}</span>}
      </button>
    );
  };

  const byCode = (c: string) => LANGUAGES.find((l) => l.code === c);

  return (
    <div className="lang-picker" ref={boxRef}>
      <div className="lang-chips">
        {chosen.map((c) => (
          <span key={c} className="lang-chip">
            {byCode(c)?.name ?? c}
            {chosen.length > 1 && (
              <button type="button" onClick={() => toggle(c)} aria-label={`Remove ${byCode(c)?.name ?? c}`}>
                <X size={11} strokeWidth={2.6} />
              </button>
            )}
          </span>
        ))}
        <button type="button" className="lang-add" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <Plus size={13} strokeWidth={2.6} /> Add languages
        </button>
      </div>

      {chosen.length > 1 && language === "auto" && (
        <p className="lang-note">
          <Info size={13} />
          <span>
            With {chosen.length} languages selected, a short clip can occasionally be heard as the wrong one.
            Dictating mostly in one language for a while? Keep only that one here, or pick it under
            Settings &rarr; Language instead of Auto-detect.
          </span>
        </p>
      )}

      {open && (
        <div className="lang-pop" role="dialog" aria-label="Choose languages">
          <label className="lang-search">
            <Search size={14} />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
              placeholder="Search 99 languages"
            />
          </label>
          <div className="lang-list">
            {indian.length > 0 && <div className="lang-group">Indian languages</div>}
            {indian.map(row)}
            {other.length > 0 && <div className="lang-group">Other languages</div>}
            {other.map(row)}
            {indian.length + other.length === 0 && <div className="lang-empty">No language matches "{query}"</div>}
          </div>
        </div>
      )}
    </div>
  );
}
