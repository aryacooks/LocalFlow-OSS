import { useEffect, useState } from "react";
import DictionaryPage from "./Dictionary";
import { SnippetsSection } from "../components/WritingSettings";
import FormatIcon from "../components/FormatIcon";
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

// One row per kind of formatting. `key` is the setting; all are on unless switched off.
// Only `fmt_ai` needs a download, everything else is built in.
type OptKey = "fmt_fillers" | "fmt_corrections" | "fmt_capitals" | "fmt_commands" | "fmt_emoji" | "fmt_ai";
/** "What you can say": the exact words each option listens for (see cleanup.rs / emoji.rs). */
interface SayGroup { label: string; words: string[]; note?: string }
const MORE: Partial<Record<OptKey, SayGroup[]>> = {
  fmt_fillers: [
    { label: "Always removed", words: ["um", "umm", "uh", "uhm", "erm", "hmm", "mhm"] },
    { label: "Removed when used as filler", note: "At the start of a phrase, before a pause.",
      words: ["so", "well", "like", "okay", "right", "look", "anyway", "actually", "basically", "literally", "honestly", "seriously", "obviously", "you know", "I mean", "you see", "I guess", "to be honest", "to tell you the truth", "at the end of the day"] },
    { label: "Removed at the very end", words: ["you know", "I mean", "you see"] },
    { label: "Hedges", note: "Kept when they mean something, like \u201cwhat kind of person\u201d.", words: ["kind of", "sort of"] },
    { label: "Always kept", note: "Real meaning stays: \u201cright now\u201d, \u201cI like it\u201d, \u201cso that it works\u201d, \u201cI think\u201d.", words: [] },
  ],
  fmt_corrections: [
    { label: "Say anywhere", note: "Everything just before it is replaced by what comes after.",
      words: ["no wait", "no actually", "actually no", "I mean", "I meant", "or rather", "or actually"] },
    { label: "With a pause around it", note: "\u201cat 6, sorry, 8\u201d types \u201cat 8\u201d; \u201cI'm sorry about that\u201d is left alone.",
      words: ["sorry", "wait", "actually", "no"] },
  ],
  fmt_capitals: [
    { label: "What it does", note: "Capitalises the first word and every word after a full stop, question mark, exclamation mark or new line. The last full stop is dropped; a final ? or ! stays.", words: [] },
  ],
  fmt_commands: [
    { label: "Punctuation", words: ["comma", "period", "full stop", "question mark", "exclamation mark", "exclamation point", "colon", "semicolon", "dot dot dot"] },
    { label: "Lines", words: ["new line", "next line", "new paragraph"] },
    { label: "Delete the last part", note: "Removes what you said since the last comma or full stop.",
      words: ["scratch that", "delete that", "cancel that", "ignore that"] },
    { label: "Delete everything", note: "Removes all you said before it; only what comes after is typed.",
      words: ["scratch all that", "delete all that", "clear all that", "scratch everything"] },
    { label: "Brackets and quotes", note: "Round ( ), square [ ], or curly { }.",
      words: ["open round bracket", "close round bracket", "open square bracket", "close square bracket", "open curly bracket", "close curly bracket", "open quote", "close quote", "quotation mark", "apostrophe"] },
    { label: "Symbols", note: "For an en dash (–), you can also say \u201cshort dash\u201d.",
      words: ["at sign", "hashtag", "dollar sign", "percent sign", "ampersand", "asterisk", "underscore", "forward slash", "backslash", "vertical bar", "tilde", "caret sign", "backtick", "degree sign", "em dash", "en dash", "short dash", "plus or minus"] },
    { label: "Maths, between two numbers or letters", note: "\u201cx equals 50\u201d types x = 50, \u201c50 percent\u201d types 50%. In normal sentences these words stay words.",
      words: ["equals", "plus", "minus", "times", "divided by", "multiplied by", "to the power of", "greater than", "less than", "greater than or equal to", "less than or equal to", "modulo", "percent"] },
  ],
  fmt_emoji: [
    { label: "How", note: "Say the emoji's name, then \u201cemoji\u201d. Around 580 names work, so try the obvious word.",
      words: ["laughing emoji", "thumbs up emoji", "heart emoji", "fire emoji", "smile emoji", "crying emoji", "party emoji", "rocket emoji", "clapping emoji", "thinking emoji", "eyes emoji", "check mark emoji", "praying emoji", "100 emoji", "sunglasses emoji", "wink emoji"] },
  ],
};

function SayList({ groups }: { groups: SayGroup[] }) {
  return (
    <details className="fmt-say">
      <summary>What you can say</summary>
      <div className="fmt-say-body">
        {groups.map((g) => (
          <div key={g.label} className="fmt-say-group">
            <div className="fmt-say-label">{g.label}</div>
            {g.note && <p className="fmt-say-note">{g.note}</p>}
            {g.words.length > 0 && (
              <div className="fmt-say-words">
                {g.words.map((w) => <span key={w}>{w}</span>)}
              </div>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

const BUILT_IN: { key: OptKey; title: string; desc: string; say: string; get: string }[] = [
  { key: "fmt_fillers", title: "Remove filler words", desc: "Drops \u201cum\u201d, \u201cuh\u201d and \u201cyou know\u201d.",
    say: "um so we should uh ship it", get: "so we should ship it" },
  { key: "fmt_corrections", title: "Follow my corrections", desc: "When you change your mind mid-sentence, only the final version is typed.",
    say: "send it to bob no wait to jim", get: "send it to jim" },
  { key: "fmt_capitals", title: "Capital letters", desc: "Starts each sentence with a capital and leaves off the full stop at the very end.",
    say: "sounds good. see you then.", get: "Sounds good. See you then" },
  { key: "fmt_commands", title: "Spoken punctuation", desc: "Say \u201ccomma\u201d, \u201cquestion mark\u201d, \u201cnew line\u201d, \u201cscratch that\u201d or \u201cscratch all that\u201d.",
    say: "are you free comma today question mark", get: "are you free, today?" },
  { key: "fmt_emoji", title: "Spoken emoji", desc: "Say the name of an emoji followed by \u201cemoji\u201d.",
    say: "nice work thumbs up emoji", get: "nice work \ud83d\udc4d" },
];
const ALL_KEYS: OptKey[] = [...BUILT_IN.map((o) => o.key), "fmt_ai"];

export default function LLMSettingsPage() {
  const [enabled, setEnabled] = useState(false);
  const [opts, setOpts] = useState<Record<OptKey, boolean>>(
    () => Object.fromEntries(ALL_KEYS.map((k) => [k, true])) as Record<OptKey, boolean>
  );
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
  
  // Test states
  const [testInput, setTestInput] = useState(
    // Exercises every option: fillers, a correction, capitals, spoken punctuation and
    // "scratch that", an emoji, and grammar for the AI rewrite.
    "um so lets meet on tuesday no wait thursday comma at the office new line can you bring the slides question mark lunch is on me scratch that i dont think their ready yet uh you know thumbs up emoji"
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

      const values = await Promise.all(ALL_KEYS.map((k) => getSetting(k).catch(() => null)));
      setOpts(Object.fromEntries(ALL_KEYS.map((k, i) => [k, values[i] !== "false"])) as Record<OptKey, boolean>);

      // The model in use is simply the downloaded one. If the saved choice isn't on
      // disk (never picked, or removed), fall over to one that is.
      const saved = (await getSetting("llm_active_model")) ?? "";
      const usable = list.find((m) => m.filename === saved && m.downloaded) ?? list.find((m) => m.downloaded);
      if (usable) {
        setActiveModel(usable.filename);
        if (usable.filename !== saved) await setSetting("llm_active_model", usable.filename);
      } else {
        setActiveModel(saved || list[0]?.filename || "");
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
    setTestOutput("");
    await setSetting("llm_enabled", nextVal ? "true" : "false");
  };

  const toggleOpt = async (key: OptKey) => {
    const next = !opts[key];
    setOpts((o) => ({ ...o, [key]: next }));
    setTestOutput("");
    await setSetting(key, next ? "true" : "false");
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
      setStatusMessage(`Removed ${model.name.replace(/\s*\(Recommended\)/, "")}.`);
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

  const downloadMb = 15 + (activeModelInfo?.size_mb ?? models[0]?.size_mb ?? 0);
  const anyOn = ALL_KEYS.some((k) => opts[k]);

  if (!loaded) return <div className="page fmt-page" />;

  return (
    <div className="page fmt-page">
      <div className="page-header">
        <div>
          <p className="page-kicker">Automatic formatting</p>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h2 className="page-title">Formatting options</h2>
            <span className="beta-tag">Beta</span>
          </div>
        </div>
      </div>

      {/* 1 — Master switch */}
      <section className="glass-panel fmt-hero">
        <div className="fmt-hero-top">
          <div className="fmt-hero-icon"><FormatIcon /></div>
          <div className="fmt-hero-text">
            <h3>Format my dictation</h3>
            <p>
              {enabled
                ? "Your words are formatted before they're typed, using the choices below. Everything runs on your Mac."
                : "Off. Your words are typed exactly as heard. Turn this on, then choose what to format below."}
            </p>
          </div>
          <button
            className={`switch ${enabled ? "on" : ""}`}
            onClick={handleToggle}
            aria-pressed={enabled}
            aria-label="Format my dictation"
          >
            <span />
          </button>
        </div>
      </section>

      {/* 2 — What to format */}
      <div className="fmt-section-head">
        <span className="section-label" style={{ margin: 0 }}>What to format</span>
        {!enabled && <span className="fmt-count">Turn on formatting to use these</span>}
      </div>
      <section className={`glass-panel fmt-opts ${enabled ? "" : "is-off"}`}>
        {BUILT_IN.map((o) => (
          <div key={o.key} className="fmt-opt">
            <div className="fmt-opt-body">
              <div className="fmt-opt-title">{o.title} <span className="fmt-badge">Built in</span></div>
              <div className="fmt-opt-desc">{o.desc}</div>
              <div className="fmt-opt-ex"><span>{o.say}</span><ArrowRight size={12} /><b>{o.get}</b></div>
              {MORE[o.key] && <SayList groups={MORE[o.key]!} />}
            </div>
            <button
              className={`switch ${opts[o.key] ? "on" : ""}`}
              disabled={!enabled}
              onClick={() => toggleOpt(o.key)}
              aria-pressed={opts[o.key]}
              aria-label={o.title}
            >
              <span />
            </button>
          </div>
        ))}

        <div className="fmt-opt">
          <div className="fmt-opt-body">
            <div className="fmt-opt-title">
              Grammar &amp; punctuation
              {setupReady
                ? <span className="fmt-badge ok"><Check size={11} strokeWidth={3} /> Installed</span>
                : <span className="fmt-badge need"><Download size={11} /> Needs a {formatSize(downloadMb)} download</span>}
            </div>
            <div className="fmt-opt-desc">
              A small AI on your Mac rewrites each dictation: adds commas and full stops, fixes grammar and apostrophes. It also makes the choices above smarter. Nothing goes online.
            </div>
            <div className="fmt-opt-ex"><span>i dont think their coming today</span><ArrowRight size={12} /><b>I don't think they're coming today</b></div>
          </div>
          <button
            className={`switch ${opts.fmt_ai ? "on" : ""}`}
            disabled={!enabled}
            onClick={() => toggleOpt("fmt_ai")}
            aria-pressed={opts.fmt_ai}
            aria-label="Grammar and punctuation"
          >
            <span />
          </button>
        </div>

        {/* What the AI option needs on disk */}
        <div className="fmt-installs">
          <div className="fmt-installs-head">
            {setupReady ? "Downloaded for Grammar & punctuation" : "Grammar & punctuation needs these two downloads"}
          </div>
          <div className={`fmt-need ${cliInstalled ? "done" : ""}`}>
            <span className="fmt-need-mark">{cliInstalled ? <Check size={14} strokeWidth={3} /> : "1"}</span>
            <div className="fmt-need-body">
              <div className="fmt-need-title">AI engine</div>
              <div className="fmt-need-desc">Runs the AI on your Mac · 15 MB</div>
            </div>
            {cliInstalled ? (
              <span className="fmt-ready"><CheckCircle size={15} /> Installed</span>
            ) : (
              <button className="button primary" disabled={downloadingCli} onClick={handleDownloadCli}>
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
            return (
              <div key={model.id} className={`fmt-need ${model.downloaded ? "done" : ""}`}>
                <span className="fmt-need-mark">{model.downloaded ? <Check size={14} strokeWidth={3} /> : String(i + 2)}</span>
                <div className="fmt-need-body">
                  <div className="fmt-need-title">
                    AI model
                    {models.length > 1 && <span className="fmt-need-name">{model.name.replace(/\s*\(Recommended\)/, "")}</span>}
                  </div>
                  <div className="fmt-need-desc">The AI that rewrites your text · {formatSize(model.size_mb)}</div>
                </div>
                {model.downloaded ? (
                  <div className="fmt-need-actions">
                    {isActive || models.filter((m) => m.downloaded).length === 1 ? (
                      <span className="fmt-ready"><CheckCircle size={15} /> Installed</span>
                    ) : (
                      <button className="button" onClick={() => handleSetActiveModel(model.filename)}>Use this one</button>
                    )}
                    <button
                      className="button danger"
                      onClick={() => handleDeleteModel(model)}
                      title="Remove the download to free up space"
                    >
                      <Trash2 size={14} />
                      {confirmDelete === model.id ? "Confirm remove" : ""}
                    </button>
                  </div>
                ) : (
                  <button
                    className="button primary"
                    disabled={isDownloading}
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
        </div>
      </section>

      {enabled && opts.fmt_ai && !setupReady && (
        <p className="fmt-note"><AlertCircle size={14} /> Grammar &amp; punctuation is skipped until both downloads finish. Your other choices still work.</p>
      )}
      {enabled && !anyOn && (
        <p className="fmt-note"><AlertCircle size={14} /> Nothing is selected, so your words are typed as heard.</p>
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
            aria-label="Text to format"
          />
          <ArrowRight size={18} className="fmt-ex-arrow" />
          <div className={`fmt-try-box out ${testOutput ? "" : "empty"}`}>
            {testOutput || "Formatted text shows up here"}
          </div>
        </div>
        <div className="fmt-try-foot">
          <span className="fmt-try-hint">
            {!enabled ? "Turn on formatting above first." : "Edit the text, then run it with your choices above."}
          </span>
          <button
            className="button primary"
            disabled={testingInference || !enabled}
            onClick={handleTestInference}
          >
            <Play size={13} />
            {testingInference ? "Formatting…" : "Format it"}
          </button>
        </div>
      </section>

      {/* Saved text you can say: works with cleanup on or off */}
      <SnippetsSection />

      {/* Custom words: works with cleanup on or off */}
      <DictionaryPage embedded />
    </div>
  );
}
