import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Ear, Pencil, Plus, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { addDictionaryEntry, deleteDictionaryEntry, DictionaryEntry, getDictionary } from "../lib/ipc";

/** Mirrors vocab.rs: the speech model reads "Term, Term, …" up to 500 characters. */
const PROMPT_BUDGET = 500;

function splitSpellings(field: string): string[] {
  return field.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
}

function termsRead(entries: DictionaryEntry[]): number {
  let len = 0;
  let n = 0;
  for (const e of entries) {
    const piece = (n === 0 ? 0 : 2) + e.term.length;
    if (len + piece + 1 > PROMPT_BUDGET) break;
    len += piece;
    n++;
  }
  return n;
}

/** The dictionary editor. `embedded` drops the page chrome so it can live inside
 *  Formatting options as a section. */
export default function DictionaryPage({ embedded = false }: { embedded?: boolean }) {
  const [entries, setEntries] = useState<DictionaryEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [term, setTerm] = useState("");
  const [soundsLike, setSoundsLike] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const termRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      setEntries(await getDictionary());
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    load().catch(console.error);
  }, []);

  const reset = () => {
    setTerm("");
    setSoundsLike("");
    setEditingId(null);
    setError("");
  };

  const handleSave = async () => {
    const t = term.trim();
    if (!t) return termRef.current?.focus();
    setSaving(true);
    setError("");
    try {
      // Editing a term's spelling: drop the old row first (terms are unique by spelling).
      const old = entries.find((e) => e.id === editingId);
      if (old && old.term !== t) await deleteDictionaryEntry(old.id);
      await addDictionaryEntry(t, splitSpellings(soundsLike).join(", "), "");
      reset();
      await load();
      termRef.current?.focus();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (e: DictionaryEntry) => {
    setEditingId(e.id);
    setTerm(e.term);
    setSoundsLike(e.pronunciation);
    setError("");
    termRef.current?.focus();
  };

  // Two-click delete (native confirm() is unreliable in the Tauri webview).
  const handleDelete = async (id: number) => {
    if (confirmId !== id) {
      setConfirmId(id);
      setTimeout(() => setConfirmId((cur) => (cur === id ? null : cur)), 3500);
      return;
    }
    setConfirmId(null);
    await deleteDictionaryEntry(id);
    if (editingId === id) reset();
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  const read = useMemo(() => termsRead(entries), [entries]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") reset();
  };

  const wrapClass = embedded ? "dict-page dict-embedded" : "page dict-page";
  if (!loaded) return <div className={wrapClass} />;

  return (
    <div className={wrapClass}>
      {embedded ? (
        <div className="fmt-section-head">
          <span className="section-label" style={{ margin: 0 }}>Dictionary</span>
          <span className="fmt-section-count">{entries.length === 1 ? "1 word" : `${entries.length} words`}</span>
        </div>
      ) : (
        <div className="page-header">
          <div>
            <p className="page-kicker">{entries.length === 1 ? "1 word" : `${entries.length} words`}</p>
            <h2 className="page-title">Dictionary</h2>
          </div>
        </div>
      )}

      {/* How the list is used */}
      <section className="dict-uses">
        <div className="dict-use">
          <span className="dict-use-icon" style={{ "--tone": "#e0662a" } as React.CSSProperties}><Ear size={15} /></span>
          <div><b>Heard right</b><span>The speech model listens for these words</span></div>
        </div>
        <div className="dict-use">
          <span className="dict-use-icon" style={{ "--tone": "#2e9e5b" } as React.CSSProperties}><Wand2 size={15} /></span>
          <div><b>Fixed every time</b><span>"Sounds like" mistakes are swapped, even with cleanup off</span></div>
        </div>
        <div className="dict-use">
          <span className="dict-use-icon" style={{ "--tone": "#c9891a" } as React.CSSProperties}><Sparkles size={15} /></span>
          <div><b>Spelled by the AI</b><span>Cleanup gets the list and catches near-misses</span></div>
        </div>
      </section>

      {/* Add / edit */}
      <section className={`glass-panel dict-form ${editingId !== null ? "is-editing" : ""}`}>
        <label className="dict-field">
          <span>Word</span>
          <input
            ref={termRef}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={onKey}
            placeholder="kubectl, Siobhán, LocalFlow…"
            maxLength={64}
            autoFocus={!embedded}
          />
        </label>
        <ArrowLeft size={16} className="dict-form-arrow" aria-hidden="true" />
        <label className="dict-field grow">
          <span>Sounds like <em>optional</em></span>
          <input
            value={soundsLike}
            onChange={(e) => setSoundsLike(e.target.value)}
            onKeyDown={onKey}
            placeholder="How it gets misheard: cube control, cube cuddle"
          />
        </label>
        <div className="dict-form-actions">
          {editingId !== null && (
            <button className="button" onClick={reset} title="Cancel editing">
              <X size={14} />
            </button>
          )}
          <button className="button primary" onClick={handleSave} disabled={saving || !term.trim()}>
            {editingId !== null ? "Save" : <><Plus size={14} /> Add</>}
          </button>
        </div>
      </section>
      {error && <p className="dict-error">{error}</p>}

      {/* The list */}
      {entries.length === 0 ? (
        <section className="glass-panel dict-empty">
          <b>No words yet</b>
          <span>Add names, product words and jargon the app keeps getting wrong.</span>
        </section>
      ) : (
        <>
          <section className="glass-panel dict-list">
            {entries.map((e) => {
              const spellings = splitSpellings(e.pronunciation);
              return (
                <div key={e.id} className={`dict-row ${editingId === e.id ? "is-editing" : ""}`}>
                  <span className="dict-term">{e.term}</span>
                  <div className="dict-spellings">
                    {spellings.length > 0 ? (
                      <>
                        <span className="dict-from">fixes</span>
                        {spellings.map((s) => <span key={s} className="dict-chip">{s}</span>)}
                      </>
                    ) : (
                      <span className="dict-from">listens for it</span>
                    )}
                  </div>
                  <div className="dict-row-actions">
                    <button className="icon-button" onClick={() => handleEdit(e)} title={`Edit ${e.term}`} aria-label={`Edit ${e.term}`}>
                      <Pencil size={14} />
                    </button>
                    <button
                      className={`icon-button danger ${confirmId === e.id ? "confirm" : ""}`}
                      onClick={() => handleDelete(e.id)}
                      title={confirmId === e.id ? "Click again to delete" : `Delete ${e.term}`}
                      aria-label={`Delete ${e.term}`}
                    >
                      <Trash2 size={14} />
                      {confirmId === e.id && <span>Delete?</span>}
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
          {read < entries.length && (
            <p className="dict-note">
              The speech model reads the first {read} of {entries.length} words. All of them are still fixed and sent to cleanup.
            </p>
          )}
        </>
      )}
    </div>
  );
}
