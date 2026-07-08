import { useEffect, useMemo, useState } from "react";
import {
  Mic,
  Accessibility,
  Download,
  Keyboard,
  Check,
  CircleAlert,
  ExternalLink,
  ArrowRight,
  ArrowLeft,
  PartyPopper,
  Loader2,
  X,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { shortcutLabel } from "../lib/utils";
import {
  getPermissionStatus,
  getInstallStatus,
  requestAccessibilityPermission,
  requestMicrophonePermission,
  openPrivacySettings,
  getTotalRamMb,
  listModels,
  listAudioDevices,
  downloadModel,
  cancelDownload,
  setActiveModel,
  startRecording,
  stopRecording,
  getSetting,
  setSetting,
  type PermissionStatus,
  type InstallStatus,
  type ModelInfo,
} from "../lib/ipc";
import logoWhite from "../assets/brand/logo_white.png";

/** First-run setup wizard. Walks a new (esp. macOS) user through the two TCC
 *  permissions the app silently needs — Microphone + Accessibility — then a model
 *  download and a hotkey test. Shows live granted/not-granted status for each. */
export default function OnboardingWizard({ onClose }: { onClose: () => void }) {
  const [perms, setPerms] = useState<PermissionStatus>({
    is_macos: true,
    is_windows: false,
    microphone: false,
    accessibility: false,
    input_monitoring: false,
  });
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [devices, setDevices] = useState<string[]>([]);
  const [install, setInstall] = useState<InstallStatus | null>(null);
  const [ramMb, setRamMb] = useState<number>(0);
  const [downloading, setDownloading] = useState<string | null>(null);
  // Live download percent per model id, fed by the backend "download-progress" event.
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [hotkey, setHotkey] = useState<string>("");
  const [step, setStep] = useState(0);
  const [actionError, setActionError] = useState("");

  const errorText = (error: unknown) =>
    error instanceof Error ? error.message : String(error || "Something went wrong.");

  // Track download percentage as the backend streams the file.
  useEffect(() => {
    const unlistenP = listen<{ id: string; progress: number }>(
      "download-progress",
      (e) => setProgress((p) => ({ ...p, [e.payload.id]: e.payload.progress })),
    );
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, []);

  // Poll permission + model state so granting in System Settings reflects live.
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const [p, m, audioDevices] = await Promise.all([
          getPermissionStatus(),
          listModels(),
          listAudioDevices(),
        ]);
        if (!active) return;
        setPerms(p);
        setModels(m);
        setDevices(audioDevices);
      } catch {
        /* backend warming up */
      }
    };
    refresh();
    const id = setInterval(refresh, 1500);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    getTotalRamMb().then(setRamMb).catch(() => {});
    getInstallStatus().then(setInstall).catch(() => {});
    getSetting("shortcut_toggle").then((v) => setHotkey(v || "Alt + F")).catch(() => {});
  }, []);

  const activeModelReady = models.some((m) => m.downloaded && m.is_active);
  const hasMicrophone = devices.length > 0;
  const microphoneReady = perms.microphone && hasMicrophone;

  // Repair an easy-to-hit state: a model exists on disk, but the saved active model
  // was deleted or belongs to a previous installation.
  useEffect(() => {
    if (!models.length || activeModelReady) return;
    const fallback = models.find((model) => model.downloaded);
    if (!fallback) return;
    setActiveModel(fallback.filename).catch((error) => setActionError(errorText(error)));
  }, [models, activeModelReady]);

  // Recommend the largest model whose RAM footprint fits in ~half of physical RAM
  // (leaving headroom for the OS + the app), falling back to the lightest model.
  const recommended = useMemo(() => {
    if (!models.length) return null;
    const budget = ramMb > 0 ? ramMb * 0.5 : Infinity;
    const fits = models.filter((m) => m.ram_mb <= budget);
    const pool = fits.length ? fits : models;
    return pool.reduce((best, m) => (m.ram_mb > best.ram_mb ? m : best), pool[0]);
  }, [models, ramMb]);

  // Steps — permission steps only matter on macOS.
  const steps = useMemo(() => {
    const base = [
      { key: "mic", title: "Microphone", icon: Mic, done: microphoneReady },
      { key: "accessibility", title: "Accessibility", icon: Accessibility, done: perms.accessibility },
      { key: "model", title: "Speech model", icon: Download, done: activeModelReady },
      { key: "hotkey", title: "Your hotkey", icon: Keyboard, done: true },
    ];
    if (perms.is_macos) return base;
    // Windows keeps the microphone step (real privacy check) but has no
    // Accessibility gate; other platforms drop both permission steps.
    if (perms.is_windows) return base.filter((s) => s.key !== "accessibility");
    return base.filter((s) => s.key !== "mic" && s.key !== "accessibility");
  }, [perms, microphoneReady, activeModelReady]);

  const current = steps[Math.min(step, steps.length - 1)];
  const isLast = step >= steps.length - 1;
  const requiredReady = steps.every((item) => item.key === "hotkey" || item.done);

  const finish = async () => {
    await setSetting("onboarding_done", "true").catch(() => {});
    onClose();
  };

  // ── Step actions ──
  const triggerMicPrompt = async () => {
    setActionError("");
    if (perms.is_macos) {
      // Prompt via AVFoundation (not cpal) so macOS refreshes its cached mic status
      // after the user allows — otherwise the app keeps reading "not granted" until a
      // restart. The 1.5s permission poll picks up the result.
      await requestMicrophonePermission().catch((error) => setActionError(errorText(error)));
      return;
    }
    // Windows/other: opening capture fires the native mic prompt the first time. If
    // it's already been denied, the prompt won't reappear — send them to Settings.
    try {
      await startRecording();
      setTimeout(() => stopRecording().catch(() => {}), 350);
    } catch (error) {
      setActionError(errorText(error));
      openPrivacySettings("microphone");
    }
  };

  const grantAccessibility = async () => {
    setActionError("");
    await requestAccessibilityPermission().catch((error) => setActionError(errorText(error)));
    openPrivacySettings("accessibility");
  };

  const downloadRecommended = async (id: string) => {
    setActionError("");
    setDownloading(id);
    setProgress((p) => ({ ...p, [id]: 0 }));
    try {
      await downloadModel(id);
      const fresh = await listModels();
      setModels(fresh);
      const m = fresh.find((x) => x.id === id);
      if (m) await setActiveModel(m.filename).catch(() => {});
    } catch (error) {
      const message = errorText(error);
      if (!message.toLowerCase().includes("cancel")) {
        setActionError(`Download failed: ${message}`);
      }
    } finally {
      setDownloading(null);
      setProgress((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      });
    }
  };

  // Ask the backend to abort the in-flight download; downloadRecommended's promise
  // then rejects and its finally-block resets the row.
  const cancelRow = async (id: string) => {
    await cancelDownload(id).catch(() => {});
  };

  const ramGb = ramMb ? (ramMb / 1024).toFixed(1) : null;

  // OS-aware copy so Windows users don't see macOS instructions.
  const deviceWord = perms.is_macos ? "Mac" : perms.is_windows ? "PC" : "computer";
  const settingsLabel = perms.is_macos ? "Open System Settings" : "Open Privacy settings";
  const micDesc = perms.is_macos
    ? "LocalFlow records your voice locally to turn it into text. macOS will ask for permission the first time."
    : "LocalFlow records your voice locally to turn it into text. If Windows is blocking the mic, turn on microphone access in Privacy settings.";

  return (
    <div className="onb-backdrop">
      <div className="onb-card">
        {/* Header */}
        <div className="onb-head">
          <div className="onb-logo">
            <img src={logoWhite} alt="LocalFlow" />
          </div>
          <div>
            <div className="onb-kicker">Welcome to LocalFlow</div>
            <h2 className="onb-title">Let's get you ready to dictate</h2>
          </div>
          <button className="onb-skip" onClick={finish}>
            Set up later
          </button>
        </div>

        {install?.is_macos &&
          (install.running_from_disk_image || install.app_translocated || install.needs_move_to_applications) && (
            <div className="onb-install-warning">
              <CircleAlert size={16} />
              <div>
                <strong>Move LocalFlow to Applications first.</strong>
                <span>
                  Quit LocalFlow, drag it into the Applications folder, eject the installer disk,
                  then reopen it. This keeps permissions and launch-at-login working reliably.
                </span>
              </div>
            </div>
          )}

        {/* Permissions-at-a-glance — macOS needs mic + accessibility, Windows just mic */}
        {(perms.is_macos || perms.is_windows) && (
          <div className="onb-perm-summary">
            <div className="onb-perm-summary-label">For LocalFlow to work fully, it needs:</div>
            <div className="onb-perm-chips">
              <PermChip label="Microphone" hint="to hear you" ok={microphoneReady} />
              {perms.is_macos && (
                <PermChip label="Accessibility" hint="to type into apps" ok={perms.accessibility} />
              )}
            </div>
          </div>
        )}

        {/* Stepper */}
        <div className="onb-stepper">
          {steps.map((s, i) => {
            const Icon = s.icon;
            const state = i === step ? "active" : s.done ? "done" : "todo";
            return (
              <button key={s.key} className={`onb-step onb-step-${state}`} onClick={() => setStep(i)}>
                <span className="onb-step-dot">
                  {s.done ? <Check size={13} strokeWidth={3} /> : <Icon size={13} strokeWidth={2.4} />}
                </span>
                <span className="onb-step-label">{s.title}</span>
              </button>
            );
          })}
        </div>

        {/* Step body */}
        <div className="onb-body">
          {current.key === "mic" && (
            <StepShell
              icon={Mic}
              done={microphoneReady}
              title="Allow the microphone"
              desc={micDesc}
            >
              {!perms.microphone ? (
                <div className="onb-actions">
                  <button className="onb-btn-primary" onClick={triggerMicPrompt}>
                    Allow microphone <ArrowRight size={14} />
                  </button>
                  <button className="onb-btn-ghost" onClick={() => openPrivacySettings("microphone")}>
                    {settingsLabel} <ExternalLink size={13} />
                  </button>
                </div>
              ) : !hasMicrophone ? (
                <div className="onb-action-error">
                  <CircleAlert size={14} /> No microphone was found. Connect or enable one, then
                  reopen LocalFlow.
                </div>
              ) : (
                <GrantedNote text="Microphone access granted." />
              )}
            </StepShell>
          )}

          {current.key === "accessibility" && (
            <StepShell
              icon={Accessibility}
              done={perms.accessibility}
              title="Allow Accessibility"
              desc="This lets LocalFlow type the transcribed text into whatever app you're using, and read which app is focused. Without it, nothing gets typed."
            >
              {!perms.accessibility ? (
                <div className="onb-actions">
                  <button className="onb-btn-primary" onClick={grantAccessibility}>
                    Grant Accessibility <ArrowRight size={14} />
                  </button>
                  <button className="onb-btn-ghost" onClick={() => openPrivacySettings("accessibility")}>
                    Open System Settings <ExternalLink size={13} />
                  </button>
                </div>
              ) : (
                <GrantedNote text="Accessibility access granted." />
              )}
              {!perms.accessibility && (
                <p className="onb-tip">
                  In System Settings → Privacy &amp; Security → Accessibility, turn the switch
                  <strong> on for LocalFlow</strong>, then come back here.
                </p>
              )}
            </StepShell>
          )}

          {current.key === "model" && (
            <StepShell
              icon={Download}
              done={activeModelReady}
              title="Download a speech model"
              desc={
                ramGb
                  ? `Your ${deviceWord} has about ${ramGb} GB of RAM — here's a model that runs comfortably on it.`
                  : "Pick a model to turn your speech into text. It runs entirely on your machine."
              }
            >
              <div className="onb-models">
                {models.map((m) => {
                  const isRec = recommended?.id === m.id;
                  const busy = downloading === m.id;
                  const pct = progress[m.id] ?? 0;
                  return (
                    <div key={m.id} className={`onb-model ${isRec ? "onb-model-rec" : ""}`}>
                      <div className="onb-model-info">
                        <div className="onb-model-name">
                          {m.name}
                          {isRec && <span className="onb-rec-badge">Recommended</span>}
                        </div>
                        <div className="onb-model-meta">
                          {Math.round(m.size_mb)} MB download · ~{(m.ram_mb / 1024).toFixed(1)} GB RAM
                        </div>
                        {busy && (
                          <div className="onb-model-bar" aria-hidden="true">
                            <div className="onb-model-bar-fill" style={{ width: `${pct}%` }} />
                          </div>
                        )}
                      </div>
                      {m.downloaded ? (
                        <span className="onb-model-ok">
                          <Check size={14} strokeWidth={3} /> Ready
                        </span>
                      ) : busy ? (
                        <div className="onb-model-actions">
                          <span className="onb-model-pct">
                            <Loader2 size={13} className="onb-spin" /> {pct}%
                          </span>
                          <button
                            className="onb-btn-ghost onb-btn-sm"
                            onClick={() => cancelRow(m.id)}
                            title="Cancel download"
                          >
                            <X size={13} /> Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          className="onb-btn-primary onb-btn-sm"
                          onClick={() => downloadRecommended(m.id)}
                        >
                          <Download size={13} /> Download
                        </button>
                      )}
                    </div>
                  );
                })}
                {!models.length && <p className="onb-tip">Loading available models…</p>}
              </div>
            </StepShell>
          )}

          {current.key === "hotkey" && (
            <StepShell
              icon={Keyboard}
              done
              title="Try your hotkey"
              desc="Press your shortcut anywhere, speak, and LocalFlow types it into the focused field."
            >
              <div className="onb-hotkey-row">
                <span className="onb-hotkey-label">Your shortcut</span>
                <kbd className="onb-kbd">{shortcutLabel(hotkey || "Alt + F")}</kbd>
                <span className="onb-hotkey-note">You can change it any time in Shortcuts.</span>
              </div>
              <textarea
                className="onb-test"
                placeholder="Click here, press your hotkey, and say “Yo, what’s up champ?” — your words should appear right here."
              />
            </StepShell>
          )}
        </div>

        {actionError && (
          <div className="onb-action-error" role="alert">
            <CircleAlert size={14} />
            <span>{actionError}</span>
          </div>
        )}

        {/* Footer nav */}
        <div className="onb-foot">
          <button
            className="onb-btn-ghost"
            disabled={step === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            <ArrowLeft size={14} /> Back
          </button>
          {isLast ? (
            <button className="onb-btn-primary" onClick={finish}>
              <PartyPopper size={15} /> {requiredReady ? "Finish setup" : "Finish later"}
            </button>
          ) : (
            <button className="onb-btn-primary" onClick={() => setStep((s) => s + 1)}>
              {current.done ? "Next" : "Do this later"} <ArrowRight size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PermChip({ label, hint, ok }: { label: string; hint: string; ok: boolean }) {
  return (
    <div className={`onb-chip ${ok ? "onb-chip-ok" : "onb-chip-bad"}`}>
      {ok ? <Check size={13} strokeWidth={3} /> : <CircleAlert size={13} strokeWidth={2.6} />}
      <span className="onb-chip-label">{label}</span>
      <span className="onb-chip-hint">{ok ? "granted" : hint}</span>
    </div>
  );
}

function StepShell({
  icon: Icon,
  done,
  title,
  desc,
  children,
}: {
  icon: typeof Mic;
  done: boolean;
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <div className="onb-step-body">
      <div className={`onb-step-icon ${done ? "onb-step-icon-done" : ""}`}>
        {done ? <Check size={20} strokeWidth={3} /> : <Icon size={20} strokeWidth={2.2} />}
      </div>
      <h3 className="onb-step-title">{title}</h3>
      <p className="onb-step-desc">{desc}</p>
      {children}
    </div>
  );
}

function GrantedNote({ text }: { text: string }) {
  return (
    <div className="onb-granted">
      <Check size={15} strokeWidth={3} /> {text}
    </div>
  );
}
