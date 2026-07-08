import { useEffect, useState } from "react";
import { CheckCircle, Download, Languages, Trash2, X } from "lucide-react";
import { listModels, ModelInfo, setActiveModel, deleteModel, getSetting, setSetting, setRomanize, cancelDownload } from "../lib/ipc";
import { useAppStore } from "../lib/store";

// Lightweight on/off switch matching the one used on the Settings page.
function Switch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button className={`switch ${checked ? "on" : ""}`} onClick={onChange} aria-pressed={checked}>
      <span />
    </button>
  );
}

const MODEL_COMPARISONS: Record<string, {
  accuracy: string;
  speed: string;
  avgRam: string;
}> = {
  "tiny.en": {
    accuracy: "Basic",
    speed: "Fastest",
    avgRam: "~130 MB"
  },
  "base.en": {
    accuracy: "Okay",
    speed: "Very fast",
    avgRam: "~160 MB"
  },
  "small.en": {
    accuracy: "Good",
    speed: "Fast",
    avgRam: "~310 MB"
  },
  "medium.en": {
    accuracy: "Very good",
    speed: "Slower",
    avgRam: "~660 MB"
  },
  "distil-large-v3": {
    accuracy: "Great",
    speed: "Slower",
    avgRam: "~900 MB"
  },
  "large-v3-turbo": {
    accuracy: "Best",
    speed: "Slowest",
    avgRam: "~1.0 GB"
  }
};

// Multilingual models that expose the romanize (Hindi → English letters) toggle.
const ROMANIZE_CAPABLE = ["large-v3-turbo"];

export default function ModelsPage() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [activeModel, setActiveModelState] = useState("ggml-small.en-q5_1.bin");
  const [downloadStatus, setDownloadStatus] = useState<Record<string, string>>({});
  // Download progress lives in the global store so it persists across navigation.
  const modelDownloads = useAppStore((s) => s.modelDownloads);
  const startModelDownload = useAppStore((s) => s.startModelDownload);
  const anyDownloading = Object.keys(modelDownloads).length > 0;
  const [autoRomanize, setAutoRomanize] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const showBanner = true;

  const load = async () => {
    const list = await listModels();
    setModels(list);
    const active = list.find((m) => m.is_active);
    if (active) {
      setActiveModelState(active.filename);
    }
  };

  useEffect(() => {
    load().catch(console.error);

    // Restore the saved auto-romanize preference (defaults ON) and push it live.
    getSetting("auto_romanize")
      .then((v) => {
        const on = v === null ? true : v === "true";
        setAutoRomanize(on);
        return setRomanize(on);
      })
      .catch(console.error);
  }, []);

  // Refresh the model list whenever a download starts or finishes (the set of active
  // ids changes) — so a model completed while on another page shows as downloaded.
  const downloadKeys = Object.keys(modelDownloads).sort().join(",");
  useEffect(() => {
    load().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadKeys]);

  const handleDownload = (model: ModelInfo) => {
    // Fire-and-forget: the store owns the download so it survives leaving this page.
    // Live progress is reflected via the global `modelDownloads` map.
    startModelDownload(model.id).catch(console.error);
  };

  const handleSetActive = async (filename: string) => {
    await setActiveModel(filename);
    setActiveModelState(filename);
  };

  // Two-click confirm: the native confirm()/alert() dialogs don't work reliably in
  // the Tauri webview (they silently return false), so the first click arms the
  // delete and the second click within the window actually removes the model.
  const handleDelete = async (model: ModelInfo) => {
    if (confirmDelete !== model.id) {
      setConfirmDelete(model.id);
      setTimeout(() => {
        setConfirmDelete((cur) => (cur === model.id ? null : cur));
      }, 4000);
      return;
    }
    setConfirmDelete(null);
    try {
      await deleteModel(model.id);
      await load();
    } catch (e) {
      setDownloadStatus((prev) => ({ ...prev, [model.id]: `Delete failed: ${e}` }));
    }
  };

  const handleToggleRomanize = async () => {
    const next = !autoRomanize;
    setAutoRomanize(next);
    try {
      await setRomanize(next);
      await setSetting("auto_romanize", next ? "true" : "false");
    } catch (e) {
      console.error("Failed to toggle auto-romanize:", e);
      setAutoRomanize(!next); // revert on failure
    }
  };

  const formatSize = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`);

  return (
    <div className="page">
      {showBanner && (
        <div className="banner-card" style={{ backgroundImage: "url('/hotorangish.png')" }}>
          <div className="banner-content">
            <h2 className="banner-title">Speech to text, <em>your</em> way.</h2>
            <p className="banner-desc">
              Pick the model that turns your voice into text. Small ones are quick but occasionally mishear you; big ones are sharper but take their sweet time. Either way, it all runs on your computer, with no internet, no account, and no one listening in.
            </p>
            <div className="banner-actions">
              <span className="banner-tag">Voice in, text out</span>
              <span className="banner-tag">Runs on your computer</span>
              <span className="banner-tag">Works on airplane mode</span>
            </div>
          </div>
        </div>
      )}

      <div className="page-header">
        <div>
          <p className="page-kicker">Speech to text</p>
          <h2 className="page-title">Language Model</h2>
        </div>
      </div>

      <section className="glass-panel" style={{ marginBottom: 14 }}>
        <p className="row-desc" style={{ margin: 0 }}>
          New here? Bigger models are noticeably more accurate, so aim as high as your computer can comfortably handle. Download a few, try them out, and keep the largest one that still runs smoothly on your machine. If you speak Hindi or mix Hindi and English, go straight for "Large V3 Turbo".
        </p>
      </section>

      <section className="grid">
        {models.map((model) => {
          const isActive = activeModel === model.filename;
          const progress = modelDownloads[model.id];
          const isDownloading = progress !== undefined;
          const status = isDownloading
            ? `Downloading... (${progress}%)`
            : downloadStatus[model.id];

          return (
            <article key={model.id} className="glass-panel model-card">
              <div className="brand-icon" style={{ width: 40, height: 40 }}>
                {model.downloaded ? <CheckCircle size={19} color="var(--success)" /> : <Download size={19} />}
              </div>

              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                  <span className="row-title">{model.name}</span>
                  {isActive && <span className="badge">Active</span>}
                </div>
                <p className="row-desc" style={{ margin: 0 }}>{model.description}</p>
                
                <div className="model-specs-grid">
                  <div className="spec-item">
                    <span className="spec-label">Accuracy</span>
                    <span className="spec-value">{MODEL_COMPARISONS[model.id]?.accuracy || "N/A"}</span>
                  </div>
                  <div className="spec-item">
                    <span className="spec-label">File Size</span>
                    <span className="spec-value">{formatSize(model.size_mb)}</span>
                  </div>
                  <div className="spec-item">
                    <span className="spec-label">Peak RAM Used</span>
                    <span className="spec-value">{MODEL_COMPARISONS[model.id]?.avgRam || `~${formatSize(model.ram_mb)}`}</span>
                  </div>
                  <div className="spec-item">
                    <span className="spec-label">Speed</span>
                    <span className="spec-value highlight">{MODEL_COMPARISONS[model.id]?.speed || "N/A"}</span>
                  </div>
                </div>

                {status && (
                  <div style={{ marginTop: 8 }}>
                    <span className="row-desc" style={{ color: "var(--accent)" }}>{status}</span>
                  </div>
                )}

                {/* Auto-romanize is only meaningful for multilingual models, and only
                    once downloaded. On: Hindi speech is written in English letters
                    (Hinglish). Off: written in Devanagari (Hindi script). */}
                {ROMANIZE_CAPABLE.includes(model.id) && model.downloaded && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      marginTop: 12,
                      paddingTop: 12,
                      borderTop: "1px solid var(--separator-soft)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Languages size={15} color="var(--accent)" />
                      <div>
                        <span className="row-title" style={{ fontSize: 13 }}>Auto-transcribe to English letters</span>
                        <p className="row-desc" style={{ margin: 0, fontSize: 11 }}>
                          On: Hindi is written in English letters (e.g. "main theek hoon"). Off: written in Hindi script (मैं ठीक हूँ).
                        </p>
                      </div>
                    </div>
                    <Switch checked={autoRomanize} onChange={handleToggleRomanize} />
                  </div>
                )}
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {model.downloaded ? (
                  <>
                    {!isActive && (
                      <button className="button" onClick={() => handleSetActive(model.filename)}>
                        Set active
                      </button>
                    )}
                    <button
                      className="button danger"
                      onClick={() => handleDelete(model)}
                      disabled={isActive}
                      title={isActive ? "Cannot delete the active model" : `Delete ${model.name}`}
                      style={{ border: "1px solid var(--separator-soft)" }}
                    >
                      <Trash2 size={14} />
                      {confirmDelete === model.id ? "Click to confirm" : ""}
                    </button>
                  </>
                ) : isDownloading ? (
                  <>
                    <button className="button primary" disabled>
                      <Download size={14} />
                      Downloading ({progress}%)
                    </button>
                    <button
                      className="button danger"
                      onClick={() => cancelDownload(model.id)}
                      title={`Cancel downloading ${model.name}`}
                      style={{ border: "1px solid var(--separator-soft)" }}
                    >
                      <X size={14} /> Cancel
                    </button>
                  </>
                ) : (
                  <button className="button primary" disabled={anyDownloading} onClick={() => handleDownload(model)}>
                    <Download size={14} />
                    Download {formatSize(model.size_mb)}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}
