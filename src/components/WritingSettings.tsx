import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import Dropdown from "./Dropdown";
import { AppSearch } from "./PrivacyExtras";
import { getSetting, listKnownApps, setSetting, type KnownApp } from "../lib/ipc";

interface Snippet { trigger: string; text: string }

/** Settings → Writing → Voice snippets (setting `snippets`). */
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

const TONES = [
  { value: "auto", label: "Let LocalFlow guess" },
  { value: "casual", label: "Casual" },
  { value: "neutral", label: "Neutral" },
  { value: "formal", label: "Formal" },
  { value: "notes", label: "Notes" },
  { value: "code", label: "Code" },
];

/** Settings → Writing → Tone per app (setting `app_tones`: {"Slack": "casual"}). */
export function AppTones() {
  const [tones, setTones] = useState<Record<string, string>>({});
  const [known, setKnown] = useState<KnownApp[]>([]);

  useEffect(() => {
    getSetting("app_tones").then((v) => {
      try { const o = JSON.parse(v ?? "{}"); if (o && typeof o === "object") setTones(o); } catch { /* empty */ }
    }).catch(() => {});
    listKnownApps().then(setKnown).catch(() => {});
  }, []);

  const save = (next: Record<string, string>) => {
    setTones(next);
    setSetting("app_tones", JSON.stringify(next)).catch(console.error);
  };
  const names = Object.keys(tones);
  const taken = new Set(names.map((n) => n.toLowerCase()));

  return (
    <div className="app-tones">
      {names.length > 0 && (
        <ul className="app-tone-list">
          {names.map((name) => (
            <li key={name} className="app-tone-item">
              <span className="app-tone-name">{name}</span>
              <Dropdown
                ariaLabel={`Tone in ${name}`}
                width={170}
                value={tones[name]}
                options={TONES}
                onChange={(v) => save({ ...tones, [name]: v })}
              />
              <button type="button" aria-label={`Remove ${name}`} onClick={() => {
                const next = { ...tones };
                delete next[name];
                save(next);
              }}>
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <AppSearch
        apps={known.filter((k) => !taken.has(k.name.toLowerCase()))}
        onPick={(name) => save({ ...tones, [name]: "casual" })}
      />
    </div>
  );
}
