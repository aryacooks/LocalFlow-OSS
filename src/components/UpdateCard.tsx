import { useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { Check, Download, RefreshCw } from "lucide-react";

type Phase =
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "available"; update: Update }
  | { kind: "installing"; update: Update; progress: number | null }
  | { kind: "restarting"; update: Update }
  | { kind: "error"; message: string; update?: Update };

/** Friendlier words for the errors people can actually hit. */
function explain(e: unknown): string {
  const m = String(e);
  if (/network|connect|dns|timed? ?out|offline|request/i.test(m)) return "Couldn't reach the update server. Check your internet connection and try again.";
  if (/signature/i.test(m)) return "The update wasn't signed by LocalFlow, so it wasn't installed.";
  if (/permission|denied|read-only/i.test(m)) return "LocalFlow couldn't replace itself. Make sure it's in your Applications folder, then try again.";
  return "Couldn't check for updates right now.";
}

/**
 * Over-the-air updates: one click downloads the new version (signed with LocalFlow's
 * update key, checked before installing), swaps it in place and restarts the app.
 * Updates come from the GitHub releases of aryacooks/LocalFlow-OSS (see .github/workflows/release.yml).
 */
export default function UpdateCard() {
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [current, setCurrent] = useState("");
  const total = useRef(0);
  const got = useRef(0);

  const runCheck = () => {
    setPhase({ kind: "checking" });
    check()
      .then((u) => setPhase(u ? { kind: "available", update: u } : { kind: "latest" }))
      .catch((e) => setPhase({ kind: "error", message: explain(e) }));
  };

  useEffect(() => {
    getVersion().then(setCurrent).catch(() => {});
    runCheck();
  }, []);

  const install = async (update: Update) => {
    total.current = 0;
    got.current = 0;
    setPhase({ kind: "installing", update, progress: null });
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") total.current = ev.data.contentLength ?? 0;
        else if (ev.event === "Progress") {
          got.current += ev.data.chunkLength;
          const p = total.current ? Math.min(100, Math.round((got.current / total.current) * 100)) : null;
          setPhase({ kind: "installing", update, progress: p });
        }
      });
      setPhase({ kind: "restarting", update });
      await relaunch();
    } catch (e) {
      setPhase({ kind: "error", message: explain(e), update });
    }
  };

  const update = "update" in phase ? phase.update : undefined;

  return (
    <section className={`glass-panel update-card ${phase.kind === "available" || phase.kind === "installing" || phase.kind === "restarting" ? "has-update" : ""}`}>
      <div className="update-card-text">
        <div className="update-card-kicker">Updates</div>
        {phase.kind === "checking" && <h3>Checking for a new version…</h3>}
        {phase.kind === "latest" && (
          <><h3><Check size={17} strokeWidth={2.8} /> You're on the latest version</h3><p>{current && `LocalFlow ${current}`}</p></>
        )}
        {phase.kind === "available" && (
          <>
            <h3>Version {phase.update.version} is ready</h3>
            <p>{phase.update.body?.trim() || `You have ${current}. It updates in place and restarts. Your models, history and settings stay as they are.`}</p>
          </>
        )}
        {phase.kind === "installing" && (
          <>
            <h3>Updating to {phase.update.version}…</h3>
            <div className={`update-progress ${phase.progress === null ? "is-indeterminate" : ""}`} role="progressbar" aria-valuenow={phase.progress ?? undefined} aria-valuemin={0} aria-valuemax={100}>
              <span style={phase.progress === null ? undefined : { width: `${phase.progress}%` }} />
            </div>
            <p>{phase.progress === null ? "Downloading…" : phase.progress < 100 ? `Downloading… ${phase.progress}%` : "Installing…"}</p>
          </>
        )}
        {phase.kind === "restarting" && <><h3>Restarting LocalFlow…</h3><p>Back in a second on version {phase.update.version}.</p></>}
        {phase.kind === "error" && <><h3>{update ? "The update didn't finish" : "Couldn't check for updates"}</h3><p>{phase.message}</p></>}
      </div>

      <div className="update-card-actions">
        {phase.kind === "available" && (
          <button type="button" className="button primary" onClick={() => install(phase.update)}>
            <Download size={15} /> Update and restart
          </button>
        )}
        {phase.kind === "error" && update && (
          <button type="button" className="button primary" onClick={() => install(update)}>
            <Download size={15} /> Try again
          </button>
        )}
        {(phase.kind === "latest" || (phase.kind === "error" && !update)) && (
          <button type="button" className="button" onClick={runCheck}>
            <RefreshCw size={15} /> Check again
          </button>
        )}
      </div>
    </section>
  );
}
