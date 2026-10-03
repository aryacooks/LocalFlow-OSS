import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getSttStatus, type SttStatus } from "./ipc";

/**
 * Live transcription-engine status. The backend emits `stt-status-changed` whenever the
 * mode, the key or the running cost changes (including after every API dictation), so
 * the Dashboard switch and the Settings page stay in step without polling.
 */
export function useSttStatus() {
  const [status, setStatus] = useState<SttStatus | null>(null);

  useEffect(() => {
    let alive = true;
    getSttStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => {});
    const unlisten = listen<SttStatus>("stt-status-changed", (e) => setStatus(e.payload));
    return () => {
      alive = false;
      unlisten.then((f) => f());
    };
  }, []);

  return [status, setStatus] as const;
}
