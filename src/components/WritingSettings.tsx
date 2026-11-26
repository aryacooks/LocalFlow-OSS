import { useEffect, useState } from "react";
import { Check, MessageSquareQuote, Pencil, Plus, Trash2, X } from "lucide-react";
import { getSetting, setSetting } from "../lib/ipc";

interface Snippet { trigger: string; text: string }

/** Formatting options → Voice snippets (setting `snippets`). */
export function SnippetsEditor() {
  const [list, setList] = useState<Snippet[]>([]);
  const [trigger, setTrigger] = useState("");
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [eTrigger, setETrigger] = useState("");
  const [eText, setEText] = useState("");

  useEffect(() => {
    getSetting("snippets").then((v) => {
      try { const a = JSON.parse(v ?? "[]"); if (Array.isArray(a)) setList(a); } catch { /* empty */ }
    }).catch(() => {});
  }, []);

  const save = (next: Snippet[]) => {
    setList(next);
    setSetting("snippets", JSON.stringify(next)).catch(console.error);
  };
  const clash = list.some((s) => s.trigger.trim().toLowerCase() === trigger.trim().toLowerCase());
  const canAdd = trigger.trim().length > 0 && text.trim().length > 0 && !clash;
  const add = () => {
    if (!canAdd) return;
    save([...list, { trigger: trigger.trim(), text }]);
    setTrigger("");
    setText("");
  };

  const startEdit = (i: number) => {
    setEditing(i);
    setETrigger(list[i].trigger);
    setEText(list[i].text);
  };
  const eClash = list.some((s, j) => j !== editing && s.trigger.trim().toLowerCase() === eTrigger.trim().toLowerCase());
  const canSave = eTrigger.trim().length > 0 && eText.trim().length > 0 && !eClash;
  const saveEdit = () => {
    if (editing === null || !canSave) return;
    save(list.map((s, j) => (j === editing ? { trigger: eTrigger.trim(), text: eText } : s)));
    setEditing(null);
  };

  return (
    <div className="snippets">
      {list.length === 0 && (
        <div className="snippet-item snippet-example" aria-label="Example snippet">
          <span className="snippet-trigger">my email</span>
          <span className="snippet-arrow" aria-hidden="true">→</span>
          <span className="snippet-text">you@example.com</span>
          <span className="snippet-example-tag">Example · yours will show here</span>
        </div>
      )}
      {list.length > 0 && (
        <ul className="snippet-list">
          {list.map((s, i) => editing === i ? (
            <li key={i} className="snippet-item snippet-item-editing">
              <input
                className="text-field"
                value={eTrigger}
                autoFocus
                onChange={(e) => setETrigger(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditing(null); }}
                aria-label="Phrase to say"
              />
              <span className="snippet-arrow" aria-hidden="true">→</span>
              <textarea
                className="text-field"
                rows={1}
                value={eText}
                onChange={(e) => setEText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }}
                aria-label="Text to type"
              />
              <button type="button" aria-label="Save changes" disabled={!canSave} onClick={saveEdit}>
                <Check size={14} />
              </button>
              <button type="button" aria-label="Cancel editing" onClick={() => setEditing(null)}>
                <X size={14} />
              </button>
            </li>
          ) : (
            <li key={i} className="snippet-item">
              <span className="snippet-trigger">{s.trigger}</span>
              <span className="snippet-arrow" aria-hidden="true">→</span>
              <span className="snippet-text">{s.text}</span>
              <button type="button" aria-label={`Edit the “${s.trigger}” snippet`} onClick={() => startEdit(i)}>
                <Pencil size={14} />
              </button>
              <button type="button" aria-label={`Delete the “${s.trigger}” snippet`} onClick={() => { save(list.filter((_, j) => j !== i)); setEditing(null); }}>
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="snippet-form">
        <input
          className="text-field"
          placeholder="When I say… (e.g. my email)"
          value={trigger}
          onChange={(e) => setTrigger(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          aria-label="Phrase to say"
        />
        <textarea
          className="text-field"
          placeholder="Type this instead"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Text to type"
        />
        <button type="button" className="button" disabled={!canAdd} onClick={add}>
          <Plus size={14} /> Add
        </button>
      </div>
      {editing !== null && eClash && <p className="snippet-note">You already have a snippet for “{eTrigger.trim()}”.</p>}
      {clash && <p className="snippet-note">You already have a snippet for “{trigger.trim()}”.</p>}
    </div>
  );
}

/** The snippets editor as a section of Formatting options, styled like the Dictionary. */
export function SnippetsSection() {
  return (
    <div className="snippets-embedded">
      <div className="dict-head">
        <span className="dict-head-icon"><MessageSquareQuote size={20} /></span>
        <div className="dict-head-text">
          <h3>Voice snippets</h3>
          <p>Say a phrase and LocalFlow types saved text instead, like your email, address or a sign-off. A one-word snippet works when you say just that word, or mid-sentence after “my” (“here is my email”). Longer phrases work anywhere.</p>
        </div>
      </div>
      <SnippetsEditor />
    </div>
  );
}
