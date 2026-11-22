import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Mic, Speaker } from "lucide-react";

/**
 * Settings → Audio input → "Check audio levels": a live meter for whatever LocalFlow
 * listens to (your mic, or system audio), without starting a dictation. Music isn't
 * paused and nothing is transcribed or saved.
 */
export default function MicCheck({ open, source, device, onClose }: {
  open: boolean;
  source: "mic" | "system";
  device: string;
  onClose: () => void;
}) {
  const [level, setLevel] = useState(0);
  const [bands, setBands] = useState<number[]>(Array(8).fill(0));
  const [peak, setPeak] = useState(0);
  // Steady background sound (fan, AC, hum): the quietest the room gets, tracked live.
  const [floor, setFloor] = useState(0);
  const floorRef = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    setError(null);
    setPeak(0);
    setFloor(0);
    floorRef.current = null;
    let live = true;
    invoke("start_level_meter").catch((e) => live && setError(String(e)));
    const id = setInterval(async () => {
      try {
        const a = await invoke<{ level?: number; bands?: number[] }>("get_amplitude");
        if (!live) return;
        const l = a?.level ?? 0;
        // Falls fast to the quietest level, rises slowly: speech is short bursts on
        // top of it, so the floor settles on the fan / AC, not on your voice.
        const f0 = floorRef.current;
        const f = f0 === null ? l : l < f0 ? f0 + (l - f0) * 0.3 : f0 + (l - f0) * 0.004;
        floorRef.current = f;
        setFloor(f);
        setLevel(l);
        // Only sound clearly above the background counts as you.
        const voice = l - f > 0.12 ? l : 0;
        setPeak((p) => Math.max(voice, p * 0.97));
        // Flatten the bars while it's only background sound.
        const gate = Math.min(1, Math.max(0, (l - f - 0.04) / 0.15));
        const raw = a?.bands?.length ? a.bands.slice(0, 8) : Array(8).fill(0);
        setBands(raw.map((b) => b * gate));
      } catch { /* keep the last values */ }
    }, 50);
    return () => {
      live = false;
      clearInterval(id);
      invoke("stop_level_meter").catch(() => {});
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const noisy = floor > 0.3;
  const verdict = error
    ? { text: error, tone: "bad" }
    : peak < 0.08 && floor > 0.08
      ? { text: source === "system" ? "Only quiet background sound. Play something on your Mac." : "Only background noise (fan, AC) so far. Say something.", tone: "idle" }
    : peak < 0.08
      ? { text: source === "system" ? "Nothing playing yet. Play something on your Mac." : "Can't hear you yet. Say something.", tone: "idle" }
      : peak < 0.35
        ? { text: source === "system" ? "Quiet. Turn the volume up a little." : "A bit quiet. Move closer or speak up.", tone: "warn" }
        : peak > 0.97
          ? { text: "Very loud. It may clip; move back a little.", tone: "warn" }
          : { text: source === "system" ? "Sounds good. LocalFlow can hear it clearly." : "Sounds good. LocalFlow can hear you clearly.", tone: "good" };

  return createPortal(
    <div className="confirm-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="confirm-dialog glass-panel mic-check"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
      >
        <div className="mic-check-head">
          <span className="mic-check-icon">{source === "system" ? <Speaker size={18} /> : <Mic size={18} />}</span>
          <div>
            <h2 id={titleId}>Check audio levels</h2>
            <p>{source === "system" ? "System audio (what your Mac is playing)" : device || "Default microphone"}</p>
          </div>
        </div>

        <div className="mic-check-bands" aria-hidden="true">
          {bands.map((b, i) => (
            <i key={i} style={{ transform: `scaleY(${Math.max(0.06, b)})` }} />
          ))}
        </div>

        <div className="mic-check-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} aria-label="Input level">
          <span className="mic-check-zone" aria-hidden="true" />
          <span className="mic-check-noise" aria-hidden="true" style={{ width: `${Math.round(floor * 100)}%` }} />
          <span className="mic-check-fill" style={{ width: `${Math.round(level * 100)}%` }} />
          <span className="mic-check-peak" style={{ left: `${Math.round(peak * 100)}%` }} />
        </div>
        <div className="mic-check-scale" aria-hidden="true"><span>Quiet</span><span>Good</span><span>Loud</span></div>

        <p className={`mic-check-verdict is-${verdict.tone}`} aria-live="polite">{verdict.text}</p>
        {floor > 0.08 && !error && (
          <p className="mic-check-note">
            <span className="mic-check-swatch" aria-hidden="true" />
            Striped part: steady background sound{noisy ? ". It's quite loud here; LocalFlow may pick it up." : ". LocalFlow ignores this much."}
          </p>
        )}

        <div className="confirm-actions">
          <button ref={closeBtn} type="button" className="button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
