import { useEffect, useState } from "react";
import { MessageSquareQuote, Plus, Trash2 } from "lucide-react";
import { getSetting, setSetting } from "../lib/ipc";

interface Snippet { trigger: string; text: string }

/** Formatting options → Voice snippets (setting `snippets`). */
export function SnippetsEditor() {
  const [list, setList] = useState<Snippet[]>([]);
  const [trigger, setTrigger] = useState("");
  const [text, setText] = useState("");

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

  return (
    <div className="snippets">
      {list.length > 0 && (
        <ul className="snippet-list">
          {list.map((s, i) => (
            <li key={s.trigger} className="snippet-item">
              <span className="snippet-trigger">“{s.trigger}”</span>
              <span className="snippet-arrow" aria-hidden="true">→</span>
              <span className="snippet-text">{s.text}</span>
              <button type="button" aria-label={`Delete the “${s.trigger}” snippet`} onClick={() => save(list.filter((_, j) => j !== i))}>
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
          <p>Say a phrase and LocalFlow types saved text instead, like your email, address or a sign-off. A one-word snippet only works when you say just that word; longer phrases also work mid-sentence.</p>
        </div>
      </div>
      <SnippetsEditor />
    </div>
  );
}
