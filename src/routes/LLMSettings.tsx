import { useEffect, useState } from "react";
import DictionaryPage from "./Dictionary";
import { Download, CheckCircle, Check, ArrowRight, Play, Trash2, AlertCircle, Sparkles } from "lucide-react";
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
  const [loaded, setLoaded] = useState(false);
  
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
    } finally {
      setLoaded(true);
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
        ? "Cleanup is on."
        : "Cleanup is off. Your words are typed exactly as spoken."
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
    setStatusMessage("");
  };

  // Clear the active model but keep cleanup.LF installed. With no model selected,
  // dictation gets basic tidying (spacing + capitalization) instead of AI cleanup.
  const handleUnselectModel = async () => {
    setActiveModel("");
    await setSetting("llm_active_model", "");
    setStatusMessage("No model in use. You get basic tidying only.");
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
    setTestOutput("");
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

  const anyModelDownloaded = models.some((m) => m.downloaded);
  const readyCount = [cliInstalled, anyModelDownloaded].filter(Boolean).length;
  const setupLabel = setupReady
    ? "All set"
    : readyCount === 2
      ? "Pick a model to use"
      : `${readyCount} of 2 installed`;

  if (!loaded) return <div className="page fmt-page" />;

  return (
    <div className="page fmt-page">
      <div className="page-header">
        <div>
          <p className="page-kicker">Automatic cleanup</p>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h2 className="page-title">Formatting options</h2>
            <span className="beta-tag">Beta</span>
          </div>
        </div>
      </div>

      {/* 1 — What it does */}
      <section className={`glass-panel fmt-hero ${enabled ? "" : "is-off"}`}>
        <div className="fmt-hero-top">
          <div className="fmt-hero-icon"><Sparkles size={20} /></div>
          <div className="fmt-hero-text">
            <h3>Tidy up my dictation</h3>
            <p>A small AI on your Mac cleans what you said before it's typed. Nothing goes online. When off, your words are typed exactly as spoken.</p>
          </div>
          <button
            className={`switch ${enabled ? "on" : ""}`}
            onClick={handleToggle}
            aria-pressed={enabled}
            aria-label="Tidy up my dictation"
          >
            <span />
          </button>
        </div>

        <div className="fmt-example">
          <div className="fmt-ex say">
            <span className="fmt-ex-tag">You say</span>
            <p>um so like we should ship it friday no wait monday cause the the tests aren't done</p>
          </div>
          <ArrowRight size={18} className="fmt-ex-arrow" />
          <div className="fmt-ex get">
            <span className="fmt-ex-tag">You get</span>
            <p>We should ship it Monday, because the tests aren't done.</p>
          </div>
        </div>

        <ul className="fmt-fixes">
          <li><Check size={13} /> Drops "um", "uh", "like"</li>
          <li><Check size={13} /> Fixes punctuation &amp; capitals</li>
          <li><Check size={13} /> Follows "no wait" corrections</li>
        </ul>
      </section>

      {/* 2 — What you need */}
      <div className="fmt-section-head">
        <span className="section-label" style={{ margin: 0 }}>What you need</span>
        <span className={`fmt-count ${setupReady ? "done" : ""}`}>
          {setupLabel}
        </span>
      </div>
      <section className="glass-panel fmt-needs">
        <div className={`fmt-need ${cliInstalled ? "done" : ""}`}>
          <span className="fmt-need-mark">{cliInstalled ? <Check size={14} strokeWidth={3} /> : "1"}</span>
          <div className="fmt-need-body">
            <div className="fmt-need-title">Cleanup engine</div>
            <div className="fmt-need-desc">Runs the AI on your Mac · one-time, 15 MB</div>
          </div>
          {cliInstalled ? (
            <span className="fmt-ready"><CheckCircle size={15} /> Installed</span>
          ) : (
            <button className="button primary" disabled={anyDownloading} onClick={handleDownloadCli}>
              <Download size={14} />
              {downloadingCli ? `${cliProgress}%` : "Install"}
            </button>
          )}
          {downloadingCli && <span className="fmt-progress" style={{ width: `${cliProgress}%` }} />}
        </div>

        {models.map((model, i) => {
          const isActive = activeModel === model.filename;
          const progress = modelDownloads[model.id];
          const isDownloading = progress !== undefined;
          const ready = model.downloaded && isActive;
          return (
            <div key={model.id} className={`fmt-need ${ready ? "done" : ""}`}>
              <span className="fmt-need-mark">{ready ? <Check size={14} strokeWidth={3} /> : String(i + 2)}</span>
              <div className="fmt-need-body">
                <div className="fmt-need-title">
                  Cleanup model <span className="fmt-need-name">{model.name.replace(/\s*\(Recommended\)/, "")}</span>
                </div>
                <div className="fmt-need-desc">
                  The AI that rewrites your text · {formatSize(model.size_mb)}
                  {model.downloaded && !isActive && <b className="fmt-need-flag"> · Downloaded, tap Use to turn it on</b>}
                </div>
              </div>
              {model.downloaded ? (
                <div className="fmt-need-actions">
                  {isActive ? (
                    <span className="fmt-ready"><CheckCircle size={15} /> In use</span>
                  ) : (
                    <button className="button" onClick={() => handleSetActiveModel(model.filename)}>Use</button>
                  )}
                  {isActive ? (
                    <button className="button" onClick={handleUnselectModel}>Stop using</button>
                  ) : (
                    <button
                      className="button danger"
                      onClick={() => handleDeleteModel(model)}
                      title={`Delete ${model.name}`}
                    >
                      <Trash2 size={14} />
                      {confirmDelete === model.id ? "Confirm" : ""}
                    </button>
                  )}
                </div>
              ) : (
                <button
                  className="button primary"
                  disabled={isDownloading || anyDownloading}
                  onClick={() => handleDownloadModel(model)}
                >
                  <Download size={14} />
                  {isDownloading ? `${progress}%` : "Download"}
                </button>
              )}
              {isDownloading && <span className="fmt-progress" style={{ width: `${progress}%` }} />}
            </div>
          );
        })}
      </section>

      {enabled && !setupReady && (
        <p className="fmt-note"><AlertCircle size={14} /> Until both are ready, you get basic tidying only (spacing and capitals).</p>
      )}
      {statusMessage && <p className="fmt-note accent"><Sparkles size={14} /> {statusMessage}</p>}

      {/* 3 — Try it */}
      <div className="fmt-section-head">
        <span className="section-label" style={{ margin: 0 }}>Try it</span>
      </div>
      <section className="glass-panel fmt-try">
        <div className="fmt-try-grid">
          <textarea
            className="fmt-try-box"
            value={testInput}
            onChange={(e) => setTestInput(e.target.value)}
            aria-label="Messy text"
          />
          <ArrowRight size={18} className="fmt-ex-arrow" />
          <div className={`fmt-try-box out ${testOutput ? "" : "empty"}`}>
            {testOutput || "Cleaned text shows up here"}
          </div>
        </div>
        <div className="fmt-try-foot">
          <span className="fmt-try-hint">
            {!enabled ? "Turn on cleanup above first." : !setupReady ? "Finish the setup above first." : "Edit the text, then run."}
          </span>
          <button
            className="button primary"
            disabled={testingInference || !enabled || !setupReady}
            onClick={handleTestInference}
          >
            <Play size={13} />
            {testingInference ? "Cleaning…" : "Clean it up"}
          </button>
        </div>
      </section>

      {/* Custom words: works with cleanup on or off */}
      <DictionaryPage embedded />
    </div>
  );
}
