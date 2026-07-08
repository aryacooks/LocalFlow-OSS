import { useEffect, useState } from "react";
import { BookOpen, Plus, Trash2 } from "lucide-react";
import { addDictionaryEntry, deleteDictionaryEntry, DictionaryEntry, getDictionary } from "../lib/ipc";

export default function DictionaryPage() {
  const [entries, setEntries] = useState<DictionaryEntry[]>([]);
  const [term, setTerm] = useState("");
  const [pronunciation, setPronunciation] = useState("");
  const [replacement, setReplacement] = useState("");
  const [adding, setAdding] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const showBanner = true;

  const load = async () => setEntries(await getDictionary());

  useEffect(() => {
    load().catch(console.error);
  }, []);

  const handleAdd = async () => {
    if (!term.trim()) return;
    setAdding(true);
    try {
      await addDictionaryEntry(term.trim(), pronunciation.trim(), replacement.trim());
      setTerm("");
      setPronunciation("");
      setReplacement("");
      setShowForm(false);
      await load();
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: number) => {
    await deleteDictionaryEntry(id);
    setEntries((prev) => prev.filter((entry) => entry.id !== id));
  };

  return (
    <div className="page">
      {showBanner && (
        <div className="banner-card" style={{ backgroundImage: "url('/orangish.png')" }}>
          <div className="banner-content">
            <h2 className="banner-title">Teach the app your <em>words</em>.</h2>
            <p className="banner-desc">
              Add names, short forms, and special words so the app spells them right when you say them.
            </p>
            <div className="banner-actions">
              <span className="banner-tag">Your words</span>
              <span className="banner-tag">Hindi + English</span>
              <span className="banner-tag">Fewer mistakes</span>
            </div>
          </div>
        </div>
      )}

      <div className="page-header">
        <div>
          <p className="page-kicker">{entries.length} vocabulary hints</p>
          <h2 className="page-title">Dictionary</h2>
        </div>
        <button className="button primary" onClick={() => setShowForm((v) => !v)}>
          <Plus size={14} />
          Add term
        </button>
      </div>

      <section className="glass-panel" style={{ display: "flex", gap: 12, marginBottom: 14 }}>
        <BookOpen size={17} color="var(--accent)" style={{ marginTop: 2, flexShrink: 0 }} />
        <p className="row-desc" style={{ margin: 0 }}>
          Add words the app often gets wrong, like names, brands, or Hindi-English words, so it spells them correctly when you speak.
        </p>
      </section>

      {showForm && (
        <section className="glass-panel" style={{ marginBottom: 14 }}>
          <div className="section-label">New entry</div>
          <div className="grid cols-3">
            <input className="field" placeholder="Term" value={term} onChange={(e) => setTerm(e.target.value)} />
            <input
              className="field"
              placeholder="Pronunciation hint"
              value={pronunciation}
              onChange={(e) => setPronunciation(e.target.value)}
            />
            <input
              className="field"
              placeholder="Replacement text"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="button primary" disabled={!term.trim() || adding} onClick={handleAdd}>
              {adding ? "Adding" : "Add entry"}
            </button>
            <button className="button" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </section>
      )}

      {entries.length === 0 ? (
        <section className="empty-state">
          <BookOpen size={40} />
          <h3>Dictionary is empty</h3>
          <p>Add your name, company, product names, technical terms, or acronyms.</p>
        </section>
      ) : (
        <section className="table-panel">
          <div className="table-row table-head" style={{ gridTemplateColumns: "1fr 1fr 1fr 32px" }}>
            <span>Term</span>
            <span>Pronunciation</span>
            <span>Replacement</span>
            <span />
          </div>
          {entries.map((entry) => (
            <div key={entry.id} className="table-row" style={{ gridTemplateColumns: "1fr 1fr 1fr 32px" }}>
              <span className="row-title truncate">{entry.term}</span>
              <span className="row-desc truncate">{entry.pronunciation || "None"}</span>
              <span className="row-desc truncate">{entry.replacement || "None"}</span>
              <button className="button icon borderless danger" onClick={() => handleDelete(entry.id)} aria-label="Delete term">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
