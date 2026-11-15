import { useEffect, useState } from "react";
import { CheckCircle, Download, Globe, Languages, Trash2, X } from "lucide-react";
import LanguagePicker from "../components/LanguagePicker";
import { listModels, ModelInfo, setActiveModel, deleteModel, getSetting, setSetting, setRomanize, cancelDownload, getTotalRamMb } from "../lib/ipc";
import { useAppStore } from "../lib/store";
import { MODEL_MEMORY_NOTE, MULTILINGUAL_NOTE, recommendationText, recommendedTranscriptionModelId } from "../lib/modelGuidance";

// Lightweight on/off switch matching the one used on the Settings page.
function Switch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button className={`switch ${checked ? "on" : ""}`} onClick={onChange} aria-pressed={checked}>
      <span />
    </button>
  );
}

// Relative scores (0–100) for the Speed / Accuracy meters, plus the RAM estimate.
const MODEL_COMPARISONS: Record<string, { speed: number; accuracy: number; avgRam: string }> = {
  "base.en": { speed: 96, accuracy: 55, avgRam: "~160 MB" },
  "small.en": { speed: 82, accuracy: 74, avgRam: "~310 MB" },
  "medium.en": { speed: 52, accuracy: 86, avgRam: "~660 MB" },
  "parakeet-tdt-v2": { speed: 99, accuracy: 93, avgRam: "~1.1 GB" },
  "large-v3-turbo": { speed: 40, accuracy: 94, avgRam: "~1.0 GB" },
  "large-v3-turbo-full": { speed: 40, accuracy: 95, avgRam: "~1.9 GB" },
  "large-v3-q5": { speed: 14, accuracy: 97, avgRam: "~1.5 GB" },
  "large-v3": { speed: 12, accuracy: 98, avgRam: "~3.9 GB" },
};

/** One labelled meter: "Speed ▬▬▬▬▬▬▬───". */
function Meter({ label, value, tone }: { label: string; value: number; tone: "ink" | "accent" }) {
  return (
    <div className="model-meter">
      <span className="model-meter-label">{label}</span>
      <span className="model-meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
        <span className={`model-meter-fill ${tone}`} style={{ width: `${value}%` }} />
      </span>
    </div>
  );
}

// Multilingual models that expose the romanize (Hindi → English letters) toggle.
const ROMANIZE_CAPABLE = ["large-v3-turbo", "large-v3-turbo-full", "large-v3-q5", "large-v3"];

export default function ModelsPage() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [ramMb, setRamMb] = useState(0);
  const offeredIds = models.map((m) => m.id);
  const recommendedId = recommendedTranscriptionModelId(ramMb, offeredIds);
  const [activeModel, setActiveModelState] = useState("ggml-small.en-q5_1.bin");
  const [downloadStatus, setDownloadStatus] = useState<Record<string, string>>({});
  // Download progress lives in the global store so it persists across navigation.
  const modelDownloads = useAppStore((s) => s.modelDownloads);
  const startModelDownload = useAppStore((s) => s.startModelDownload);
  const [autoRomanize, setAutoRomanize] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

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
    getTotalRamMb().then(setRamMb).catch(console.error);

    // Restore the saved romanize preference (defaults OFF) and push it live.
    getSetting("romanize_hindi")
      .then((v) => {
        const on = v === "true";
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
      await setSetting("romanize_hindi", next ? "true" : "false");
    } catch (e) {
      console.error("Failed to toggle auto-romanize:", e);
      setAutoRomanize(!next); // revert on failure
    }
  };

  const formatSize = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`);

  return (
    <div className="page">

      <div className="page-header">
        <div>
          <p className="page-kicker">Speech to text</p>
          <h2 className="page-title">Language Model</h2>
        </div>
      </div>

      <section className="glass-panel" style={{ marginBottom: 14 }}>
        <p className="row-desc" style={{ margin: 0 }}>
          {recommendationText(ramMb, offeredIds)} {MULTILINGUAL_NOTE}
        </p>
        <p className="row-desc" style={{ margin: "8px 0 0" }}>
          {MODEL_MEMORY_NOTE}
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
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 3 }}>
                  <span className="row-title">{model.name}</span>
                  {isActive && <span className="badge">Active</span>}
                  {model.id === recommendedId && <span className="badge">Recommended</span>}
                </div>
                <p className="row-desc" style={{ margin: 0 }}>{model.description}</p>
                
                {MODEL_COMPARISONS[model.id] && (
                  <div className="model-meters">
                    <Meter label="Speed" value={MODEL_COMPARISONS[model.id].speed} tone="ink" />
                    <Meter label="Accuracy" value={MODEL_COMPARISONS[model.id].accuracy} tone="accent" />
                  </div>
                )}
                <div className="model-meta">
                  {formatSize(model.size_mb)} download · {MODEL_COMPARISONS[model.id]?.avgRam || `~${formatSize(model.ram_mb)}`} RAM
                </div>

                {status && (
                  <div style={{ marginTop: 8 }}>
                    <span className="row-desc" style={{ color: "var(--accent)" }}>{status}</span>
                  </div>
                )}

                {/* Auto-romanize is only meaningful for multilingual models, and only
                    once downloaded. On: Hindi speech is written in English letters
                    (Hinglish). Off: written in Devanagari (Hindi script). */}
                {/* Languages the multilingual model listens for; auto-detect picks among them. */}
                {ROMANIZE_CAPABLE.includes(model.id) && model.downloaded && (
                  <div className="model-langs">
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <Globe size={15} color="var(--accent)" />
                      <div>
                        <span className="row-title" style={{ fontSize: 13 }}>Languages you speak</span>
                        <p className="row-desc" style={{ margin: 0, fontSize: 11 }}>
                          Auto-detect picks between these. Fewer languages means fewer wrong guesses.
                        </p>
                      </div>
                    </div>
                    <LanguagePicker />
                  </div>
                )}

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
                          For Hindi and other Devanagari languages. On: written in English letters (e.g. "main theek hoon"). Off: written in Hindi script (मैं ठीक हूँ).
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
                  <button className="button primary" onClick={() => handleDownload(model)}>
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
