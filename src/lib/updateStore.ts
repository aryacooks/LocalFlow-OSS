import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { checkUpdate, installUpdate, type UpdateStatus } from "./ipc";

type Phase =
  | { kind: "idle" | "checking" }
  | { kind: "latest"; status: UpdateStatus }
  | { kind: "available"; status: UpdateStatus }
  | { kind: "installing"; status: UpdateStatus; progress: number | null }
  | { kind: "restarting"; status: UpdateStatus }
  | { kind: "error"; message: string; detail: string; status?: UpdateStatus; restartOnly?: boolean };

/** Friendlier words for the errors people can actually hit. */
function explain(e: unknown): string {
  const m = String(e);
  if (/network|connect|dns|timed? ?out|offline|request|error sending/i.test(m)) return "Couldn't reach the update server. Check your internet connection and try again.";
  if (/signature/i.test(m)) return "The update wasn't signed by LocalFlow, so it wasn't installed.";
  if (/permission|denied|read-only/i.test(m)) return "LocalFlow couldn't replace itself. Make sure it's in your Applications folder, then try again.";
  return "Couldn't check for updates right now.";
}

// The main window owns one update session across all routes.
export const useUpdateStore = create<{ phase: Phase }>(() => ({ phase: { kind: "idle" } }));
const setPhase = (phase: Phase) => useUpdateStore.setState({ phase });

export async function runCheck() {
  const { phase } = useUpdateStore.getState();
  if (phase.kind === "checking" || phase.kind === "installing" || phase.kind === "restarting"
    || (phase.kind === "error" && phase.status)) return;
  setPhase({ kind: "checking" });
  try {
    const status = await checkUpdate();
    setPhase({ kind: status.available ? "available" : "latest", status });
  } catch (error) {
    setPhase({ kind: "error", message: explain(error), detail: String(error) });
  }
}

export async function install() {
  const { phase } = useUpdateStore.getState();
  if (phase.kind !== "available" && phase.kind !== "error") return;
  const status = phase.status;
  if (!status) return;

  if (!(phase.kind === "error" && phase.restartOnly)) {
    setPhase({ kind: "installing", status, progress: null });
    let stop: UnlistenFn | undefined;
    try {
      stop = await listen<[number, number | null]>("update-progress", ({ payload: [got, total] }) => {
        if (useUpdateStore.getState().phase.kind === "installing") {
          setPhase({ kind: "installing", status, progress: total ? Math.min(100, Math.round(got / total * 100)) : null });
        }
      });
      await installUpdate();
    } catch (error) {
      setPhase({ kind: "error", status, message: explain(error), detail: String(error) });
      return;
    } finally {
      stop?.();
    }
  }
  setPhase({ kind: "restarting", status });
  try {
    await relaunch();
  } catch (error) {
    setPhase({ kind: "error", status, restartOnly: true, message: "The update is installed. Restart LocalFlow to finish.", detail: String(error) });
  }
}
