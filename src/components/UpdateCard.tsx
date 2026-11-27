import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Check, Download, RefreshCw } from "lucide-react";
import { install, runCheck, useUpdateStore } from "../lib/updateStore";

/** "Installed 0.1.0 · Latest 0.1.25", the two numbers people want to compare. */
function Versions({ current, latest }: { current: string; latest: string | null }) {
  return <dl className="update-versions">
    <div><dt>Installed</dt><dd>{current || "…"}</dd></div>
    <div><dt>Latest</dt><dd>{latest ?? "unknown"}</dd></div>
  </dl>;
}

/**
 * One-click updates (src-tauri/src/update.rs): checks the newest GitHub release,
 * downloads the signed update, swaps the app in place and restarts it.
 */
export default function UpdateCard() {
  const phase = useUpdateStore(s => s.phase);
  const [current, setCurrent] = useState("");

  useEffect(() => {
    getVersion().then(setCurrent).catch(() => {});
    void runCheck();
  }, []);

  const status = "status" in phase ? phase.status : undefined;
  const busy = phase.kind === "available" || phase.kind === "installing" || phase.kind === "restarting";

  return (
    <section className={`glass-panel update-card ${busy ? "has-update" : ""} ${phase.kind === "latest" ? "is-current" : ""}`}>
      <div className="update-card-text">
        <div className="update-card-kicker">Updates</div>
        {(phase.kind === "idle" || phase.kind === "checking") && <h3>Checking for a new version…</h3>}
        {phase.kind === "latest" && (
          <>
            <h3><Check size={17} strokeWidth={2.8} /> You're up to date</h3>
            <p>You have the newest version of LocalFlow.</p>
          </>
        )}
        {phase.kind === "available" && (
          <>
            <h3>Version {phase.status.latest} is ready</h3>
            <p>{phase.status.notes?.trim() || "It updates in place and restarts. Your models, history and settings stay as they are."}</p>
          </>
        )}
        {phase.kind === "installing" && (
          <>
            <h3>Updating to {phase.status.latest}…</h3>
            <div className={`update-progress ${phase.progress === null ? "is-indeterminate" : ""}`} role="progressbar" aria-valuenow={phase.progress ?? undefined} aria-valuemin={0} aria-valuemax={100}>
              <span style={phase.progress === null ? undefined : { width: `${phase.progress}%` }} />
            </div>
            <p>{phase.progress === null ? "Downloading…" : phase.progress < 100 ? `Downloading… ${phase.progress}%` : "Installing…"}</p>
          </>
        )}
        {phase.kind === "restarting" && <><h3>Restarting LocalFlow…</h3><p>Back in a second on version {phase.status.latest}.</p></>}
        {phase.kind === "error" && (
          <>
            <h3>{phase.status ? "The update didn't finish" : "Couldn't check for updates"}</h3>
            <p>{phase.message}</p>
            <p className="update-error-detail">{phase.detail}</p>
          </>
        )}
      </div>

      <div className="update-card-side">
        <Versions current={status?.current || current} latest={phase.kind === "checking" ? "…" : status?.latest ?? null} />
        <div className="update-card-actions">
          {phase.kind === "available" && (
            <button type="button" className="button primary" onClick={install}>
              <Download size={15} /> Update and restart
            </button>
          )}
          {phase.kind === "error" && phase.status && (
            <button type="button" className="button primary" onClick={install}>
              <RefreshCw size={15} /> {phase.restartOnly ? "Restart LocalFlow" : "Try again"}
            </button>
          )}
          {(phase.kind === "latest" || (phase.kind === "error" && !phase.status)) && (
            <button type="button" className="button" onClick={runCheck}>
              <RefreshCw size={15} /> Check again
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
