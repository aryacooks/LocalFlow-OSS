import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Clipboard, Search, Trash2 } from "lucide-react";
import { clearHistory, deleteHistoryEntry, DictationEntry, getAppIcon, getHistory, getSetting, setSetting } from "../lib/ipc";
import { useAppStore } from "../lib/store";
import { appColor } from "../lib/utils";

/** "localflow" and "LocalFlow" are the same app: show one tidy name. */
function displayName(entry: DictationEntry): string {
  const n = (entry.app_name || "").replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "").trim();
  if (!n || n.toLowerCase() === "unknown") return "Unknown app";
  if (/^localflow$/i.test(n)) return "LocalFlow";
  return n === n.toLowerCase() ? n.charAt(0).toUpperCase() + n.slice(1) : n;
}

// Stored timestamps are UTC ("YYYY-MM-DD HH:MM:SS"); show them in local time.
function parseTs(ts: string): Date {
  const d = new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? new Date(ts) : d;
}

function dayLabel(d: Date): string {
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short", day: "numeric", month: "short",
    ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
}

const timeOf = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

// One lookup per app, shared by every row that shows it.
const iconCache = new Map<string, Promise<string | null>>();
function iconFor(entry: DictationEntry): Promise<string | null> {
  const key = `${entry.app_name}|${entry.app_exe}`;
  let p = iconCache.get(key);
  if (!p) {
    p = getAppIcon(entry.app_name, entry.app_exe).catch(() => null);
    iconCache.set(key, p);
  }
  return p;
}

/** The app's real icon (macOS), or a letter badge in the app's colour. */
function AppIcon({ entry }: { entry: DictationEntry }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    iconFor(entry).then((s) => { if (live) setSrc(s); });
    return () => { live = false; };
  }, [entry.app_name, entry.app_exe]);
  if (src) return <img className="history-icon" src={src} alt="" />;
  const color = appColor(entry.app_exe || entry.app_name || "");
  return (
    <span className="history-icon history-icon-letter" style={{ background: color }}>
      {displayName(entry).charAt(0).toUpperCase()}
    </span>
  );
}

function HistoryRow({ entry, onDelete }: { entry: DictationEntry; onDelete: (id: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const when = parseTs(entry.timestamp);
  const text = entry.cleaned_text;

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(console.error);
  };

  return (
    <article className={`history-row ${expanded ? "is-open" : ""}`}>
      <div className="history-summary" role="button" tabIndex={0}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded((v) => !v); } }}>
        <AppIcon entry={entry} />
        <div className="history-main">
          <div className="history-meta">
            <span className="history-app">{displayName(entry)}</span>
            <span className="history-time">{timeOf(when)}</span>
            {entry.formatted === false && (
              <span className="history-tag" title="Formatting options were turned off for this message">Formatting off</span>
            )}
          </div>
          <p className={`history-text ${text ? "" : "is-empty"} ${expanded ? "is-full" : ""}`}>
            {text || "Text not saved (history was off)"}
          </p>
        </div>
        <div className="history-side">
          <span className="history-stats">{entry.word_count} words · {Math.round(entry.duration_secs)}s</span>
          {text && (
            <button className="history-iconbtn" onClick={copy} title={copied ? "Copied" : "Copy text"} aria-label="Copy text">
              {copied ? <Check size={14} /> : <Clipboard size={14} />}
            </button>
          )}
          <ChevronDown size={15} className="history-chevron" />
        </div>
      </div>

      {expanded && (
        <div className="history-detail">
          {entry.formatted === false && (
            <p className="subtle history-note">Formatting options were turned off for this message, so it was typed as heard.</p>
          )}
          {entry.formatted !== false && entry.raw_text && entry.raw_text !== entry.cleaned_text && (
            <div>
              <div className="section-label">Before formatting</div>
              <p className="history-raw">{entry.raw_text}</p>
            </div>
          )}
          <div className="history-actions">
            <span className="subtle">
              {when.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })}
              {entry.language ? ` · ${entry.language}` : ""}
            </span>
            <button className="button danger" onClick={() => onDelete(entry.id)}>
              <Trash2 size={14} />
              Delete
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function groupByDay(entries: DictationEntry[]): [string, DictationEntry[]][] {
  const out: [string, DictationEntry[]][] = [];
  for (const e of entries) {
    const label = dayLabel(parseTs(e.timestamp));
    const last = out[out.length - 1];
    if (last && last[0] === label) last[1].push(e);
    else out.push([label, [e]]);
  }
  return out;
}

export default function HistoryPage() {
  const [entries, setEntries] = useState<DictationEntry[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saveHistoryEnabled, setSaveHistoryEnabled] = useState(true);
  const { lastTranscript } = useAppStore();

  const loadSetting = useCallback(async () => {
    try {
      const val = await getSetting("save_history");
      setSaveHistoryEnabled(val !== "false");
    } catch (e) {
      console.error("Failed to load save_history setting:", e);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await getHistory(search || undefined, 100));
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    loadSetting().catch(console.error);
    load().catch(console.error);
  }, [load, loadSetting, lastTranscript]);

  const handleToggleSaveHistory = async () => {
    const nextVal = !saveHistoryEnabled;
    setSaveHistoryEnabled(nextVal);
    await setSetting("save_history", nextVal ? "true" : "false");
  };

  const handleDelete = async (id: number) => {
    await deleteHistoryEntry(id);
    setEntries((prev) => prev.filter((entry) => entry.id !== id));
  };

  const handleClearAll = async () => {
    if (!confirm("Delete all dictation history? This cannot be undone.")) return;
    await clearHistory();
    setEntries([]);
  };

  return (
    <div className="page">

      <div className="page-header">
        <div>
          <p className="page-kicker">{entries.length} saved dictations</p>
          <h2 className="page-title">History</h2>
        </div>
        {entries.length > 0 && (
          <button className="button danger" onClick={handleClearAll}>
            <Trash2 size={14} />
            Clear all
          </button>
        )}
      </div>

      <section className="glass-panel" style={{ marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px" }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Save what I dictate</h3>
          <p className="row-desc" style={{ margin: "2px 0 0 0", fontSize: 11.5 }}>
            When off, the app keeps only counts like how many words you spoke, and the actual text is not saved.
          </p>
        </div>
        <button
          className={`switch ${saveHistoryEnabled ? "on" : ""}`}
          onClick={handleToggleSaveHistory}
          aria-pressed={saveHistoryEnabled}
        >
          <span />
        </button>
      </section>

      <div className="search-field" style={{ marginBottom: 14 }}>
        <Search />
        <input className="field" placeholder="Search transcripts" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {loading ? (
        <div className="glass-panel subtle">Loading history...</div>
      ) : entries.length === 0 ? (
        <section className="empty-state">
          <Search size={38} />
          <h3>{search ? "No matching dictations" : "No dictations yet"}</h3>
          <p>{search ? "Try a different term." : "Recorded dictations will appear here after your first session."}</p>
        </section>
      ) : (
        <div className="history-groups">
          {groupByDay(entries).map(([label, items]) => (
            <section key={label} className="history-group">
              <h3 className="history-day">{label}</h3>
              <div className="history-list">
                {items.map((entry) => (
                  <HistoryRow key={entry.id} entry={entry} onDelete={handleDelete} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
