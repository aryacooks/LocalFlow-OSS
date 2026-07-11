import { useEffect, useState } from "react";
import { Download, CheckCircle, Cpu, Play, Trash2, AlertCircle, Sparkles } from "lucide-react";
import {
  listLlmModels,
  isLlamaCliInstalled,
  deleteLlmModel,
  getSetting,
  setSetting,
  LlmModelInfo,
} from "../lib/ipc";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../lib/store";

export default function LLMSettingsPage() {
  const [enabled, setEnabled] = useState(false);
  const [cliInstalled, setCliInstalled] = useState(false);
  const [models, setModels] = useState<LlmModelInfo[]>([]);
  const [activeModel, setActiveModel] = useState("Llama-3.2-1B-Instruct-Q4_K_M.gguf");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const showBanner = true;
  
  // Action states — downloads live in the global store so progress survives navigating
  // away from this page (the backend keeps downloading regardless).
  const [statusMessage, setStatusMessage] = useState("");
  const modelDownloads = useAppStore((s) => s.modelDownloads);
  const startLlmModelDownload = useAppStore((s) => s.startLlmModelDownload);
  const startLlmCliDownload = useAppStore((s) => s.startLlmCliDownload);
  const cliProgress = modelDownloads["llama-cli"];
  const downloadingCli = cliProgress !== undefined;
  const anyDownloading = Object.keys(modelDownloads).length > 0;
  
  // Test states
  const [testInput, setTestInput] = useState(
    "so um, yesterday i went to the office no i mean i went to the park and like it was raining uh you know"
  );
  const [testOutput, setTestOutput] = useState("");
  const [testingInference, setTestingInference] = useState(false);

  const loadData = async () => {
    try {
      const cliStatus = await isLlamaCliInstalled();
      setCliInstalled(cliStatus);
      
      const list = await listLlmModels();
      setModels(list);
      
      const dbEnabled = await getSetting("llm_enabled");
      setEnabled(dbEnabled === "true");

      const active = list.find((m) => m.is_active);
      if (active) {
        setActiveModel(active.filename);
      } else {
        const dbActive = await getSetting("llm_active_model");
        if (dbActive) setActiveModel(dbActive);
      }
    } catch (e) {
      console.error("Failed to load LLM settings:", e);
    }
  };

  useEffect(() => {
    loadData().catch(console.error);
  }, []);

  // Refresh helper/model state whenever a download starts or finishes (the set of
  // active ids changes), so anything completed on another page shows as ready here.
  const downloadKeys = Object.keys(modelDownloads).sort().join(",");
  useEffect(() => {
    loadData().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadKeys]);

  const handleToggle = async () => {
    const nextVal = !enabled;
    setEnabled(nextVal);
    await setSetting("llm_enabled", nextVal ? "true" : "false");
    setStatusMessage(
      nextVal
        ? "Auto-cleanup is on. Once the helper and a cleanup model are downloaded, your dictation will be tidied up automatically."
        : "Auto-cleanup is off. Your dictation will get light tidying only (basic spacing and capitalization)."
    );
  };

  const handleDownloadCli = () => {
    // Fire-and-forget: the store owns the download so it survives leaving this page.
    startLlmCliDownload().catch(console.error);
  };

  const handleDownloadModel = (model: LlmModelInfo) => {
    startLlmModelDownload(model.id).catch(console.error);
  };

  const handleSetActiveModel = async (filename: string) => {
    setActiveModel(filename);
    await setSetting("llm_active_model", filename);
    setStatusMessage(`Selected ${filename} as active formatting model.`);
  };

  // Clear the active model but keep cleanup.LF installed. With no model selected,
  // dictation gets basic tidying (spacing + capitalization) instead of AI cleanup.
  const handleUnselectModel = async () => {
    setActiveModel("");
    await setSetting("llm_active_model", "");
    setStatusMessage(
      "No cleanup model selected. Dictation will get basic tidying only (spacing and capitalization)."
    );
  };

  // Two-click confirm (native confirm() is unreliable in the Tauri webview).
  const handleDeleteModel = async (model: LlmModelInfo) => {
    if (confirmDelete !== model.id) {
      setConfirmDelete(model.id);
      setTimeout(() => {
        setConfirmDelete((cur) => (cur === model.id ? null : cur));
      }, 4000);
      return;
    }
    setConfirmDelete(null);
    try {
      await deleteLlmModel(model.id);
      setStatusMessage(`Deleted ${model.name}.`);
      await loadData();
    } catch (e) {
      setStatusMessage(`Delete failed: ${e}`);
    }
  };

  const handleTestInference = async () => {
    setTestingInference(true);
    setTestOutput("Formatting...");
    try {
      // Invoke llm inference command directly
      const result = await invoke<string>("cleanup_text", {
        rawText: testInput,
        appExe: "notion.exe"
      });
      setTestOutput(result);
    } catch (e) {
      setTestOutput(`Error: ${e}`);
    } finally {
      setTestingInference(false);
    }
  };

  const formatSize = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`);
  const activeModelInfo = models.find((model) => model.filename === activeModel);
  const activeModelDownloaded = !!activeModelInfo?.downloaded;
  const setupReady = cliInstalled && activeModelDownloaded;

  return (
    <div className="page" style={{ position: "relative", minHeight: "calc(100vh - 100px)" }}>
      {showBanner && (
        <div className="banner-card" style={{ backgroundImage: "url('/Local LLM Background.png')" }}>
          <div className="banner-content">
            <h2 className="banner-title">Cleaner text, <em>automatically</em>.</h2>
            <p className="banner-desc">
              Let the app tidy up after you. It sweeps out every "um" and "uh", fixes your punctuation, and untangles the sentences you said sideways. All of it happens quietly on your computer, with zero judgment.
            </p>
            <div className="banner-actions">
              <span className="banner-tag">Bye-bye "um"</span>
              <span className="banner-tag">Fixes punctuation</span>
              <span className="banner-tag">Zero judgment</span>
            </div>
          </div>
        </div>
      )}

      <div className="page-header">
        <div>
          <p className="page-kicker">Automatic cleanup</p>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h2 className="page-title">Formatting options</h2>
            <span className="beta-tag">Beta</span>
          </div>
        </div>
      </div>

      <section className="glass-panel" style={{ marginBottom: 18, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h3 className="section-title" style={{ margin: 0, fontSize: 15 }}>Tidy up my dictation automatically</h3>
            <p className="row-desc" style={{ margin: "4px 0 0 0" }}>
              Removes filler words like "um" and "uh", fixes punctuation, and cleans up your sentences. Runs privately on your computer. Needs the two downloads below.
            </p>
            <div className="cleanup-example">
              <div className="cleanup-ex-row">
                <span className="cleanup-ex-tag say">You say</span>
                <span className="cleanup-ex-text say">
                  um so like we should ship it friday no wait monday cause the the tests aren't done
                </span>
              </div>
              <div className="cleanup-ex-row">
                <span className="cleanup-ex-tag get">You get</span>
                <span className="cleanup-ex-text get">
                  We should ship monday cause the the tests aren't done.
                </span>
              </div>
            </div>
          </div>
          <button
            className={`switch ${enabled ? "on" : ""}`}
            onClick={handleToggle}
            aria-pressed={enabled}
          >
            <span />
          </button>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, paddingTop: 4 }}>
          <span className={`badge ${enabled ? "success" : ""}`}>
            {enabled ? "Cleanup on" : "Cleanup off"}
          </span>
          <span className={`badge ${cliInstalled ? "success" : "warning"}`}>
            Helper {cliInstalled ? "ready" : "needed"}
          </span>
          <span className={`badge ${activeModelDownloaded ? "success" : "warning"}`}>
            Model {activeModelDownloaded ? "ready" : "needed"}
          </span>
        </div>
      </section>

      {enabled && !setupReady && (
        <section className="glass-panel mac-callout" style={{ marginBottom: 18, borderColor: "var(--warning)" }}>
          <AlertCircle size={16} color="var(--warning)" />
          <p className="row-desc" style={{ margin: 0, fontWeight: 500 }}>
            Cleanup is on, but until you download the helper and a cleanup model below, your dictation will only get light tidying (basic spacing and capitalization).
          </p>
        </section>
      )}

      {statusMessage && (
        <section className="glass-panel mac-callout" style={{ marginBottom: 18, borderColor: "var(--accent)" }}>
          <Sparkles size={16} color="var(--accent)" />
          <p className="row-desc" style={{ margin: 0, fontWeight: 500 }}>{statusMessage}</p>
        </section>
      )}

      {/* cleanup helper setup */}
      <section className="section-label" style={{ marginBottom: 6 }}>1. Download the cleanup helper</section>
      <section className="glass-panel" style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="row-title" style={{ fontSize: 14 }}>cleanup.LF</span>
              {cliInstalled ? (
                <span className="badge success">Installed</span>
              ) : (
                <span className="badge warning">Not installed</span>
              )}
            </div>
            <p className="row-desc" style={{ marginTop: 4, marginBottom: 0 }}>
              A small one-time download that lets the cleanup run on your computer, without the internet. You only need to do this once.
            </p>
          </div>
          <div>
            {!cliInstalled ? (
              <button
                className="button primary"
                disabled={anyDownloading}
                onClick={handleDownloadCli}
              >
                <Download size={14} />
                {downloadingCli ? `Downloading (${cliProgress}%)` : "Download (15 MB)"}
              </button>
            ) : (
              <span style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--success)", fontSize: 13, fontWeight: 500 }}>
                <CheckCircle size={15} /> Ready
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Model Download List */}
      <section className="section-label" style={{ marginBottom: 6 }}>2. Choose a cleanup model</section>
      <section className="grid" style={{ marginBottom: 18 }}>
        {models.map((model) => {
          const isActive = activeModel === model.filename;
          const progress = modelDownloads[model.id];
          const isDownloading = progress !== undefined;

          return (
            <article key={model.id} className="glass-panel model-card">
              <div className="brand-icon" style={{ width: 40, height: 40 }}>
                {model.downloaded ? <CheckCircle size={19} color="var(--success)" /> : <Download size={19} />}
              </div>

              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                  <span className="row-title">{model.name}</span>
                  {isActive && model.downloaded && <span className="badge">Active</span>}
                </div>
                <p className="row-desc" style={{ margin: 0 }}>{model.description}</p>
                <div className="model-meta">
                  <span className="row-desc">
                    <Cpu size={13} />
                    Size: {formatSize(model.size_mb)}
                  </span>
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {model.downloaded ? (
                  <>
                    {!isActive ? (
                      <button className="button" onClick={() => handleSetActiveModel(model.filename)}>
                        Select
                      </button>
                    ) : (
                      <button className="button" onClick={handleUnselectModel}>
                        Unselect
                      </button>
                    )}
                    <button
                      className="button danger"
                      onClick={() => handleDeleteModel(model)}
                      disabled={isActive}
                      title={isActive ? "Cannot delete the active model" : `Delete ${model.name}`}
                      style={{ border: "1px solid var(--separator-soft)" }}
                    >
                      <Trash2 size={14} />
                      {confirmDelete === model.id ? "Click to confirm" : ""}
                    </button>
                  </>
                ) : (
                  <button
                    className="button primary"
                    disabled={isDownloading || anyDownloading}
                    onClick={() => handleDownloadModel(model)}
                  >
                    <Download size={14} />
                    {isDownloading
                      ? `Downloading (${progress}%)`
                      : `Download ${formatSize(model.size_mb)}`}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </section>

      {/* Test Inference area */}
      <section className="section-label" style={{ marginBottom: 6 }}>3. Try it out</section>
      <section className="glass-panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="grid-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div>
            <span className="setting-title" style={{ display: "block", marginBottom: 6 }}>Type some messy text</span>
            <textarea
              className="select"
              style={{ width: "100%", height: 110, padding: 8, resize: "none", fontSize: 13 }}
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
            />
          </div>
          <div>
            <span className="setting-title" style={{ display: "block", marginBottom: 6 }}>Cleaned-up result</span>
            <div
              style={{
                width: "100%",
                height: 110,
                padding: 8,
                borderRadius: 6,
                backgroundColor: "rgba(0, 0, 0, 0.25)",
                border: "1px solid var(--separator-soft)",
                fontSize: 13,
                overflowY: "auto",
                whiteSpace: "pre-wrap"
              }}
            >
              {testOutput || <span style={{ color: "var(--secondary)" }}>Output will appear here...</span>}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--separator-soft)", paddingTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--secondary)" }}>
            <AlertCircle size={14} />
            <span style={{ fontSize: 11 }}>Turn on cleanup and download the helper and a model first.</span>
          </div>
          <button
            className="button primary"
            disabled={testingInference || !enabled || !setupReady}
            onClick={handleTestInference}
          >
            <Play size={13} />
            {testingInference ? "Formatting..." : "Run Test"}
          </button>
        </div>
      </section>
    </div>
  );
}
