import { useEffect, useRef, useState } from "react";
import OrbBubble, { ORB_VARIANTS, type OrbSignal, type OrbVariant } from "../windows/OrbBubble";

/** Fake voice for the previews: syllables at a talking pace, with short pauses. */
function useFakeVoice() {
  const signal = useRef<OrbSignal>({ level: 0, bands: new Array(8).fill(0) });
  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      const t = now / 1000;
      const phrase = t % 4.2; // ~3.4 s of talking, then a breath
      const talking = phrase < 3.4 ? 1 : 0;
      const syllable = Math.pow(Math.max(0, Math.sin(t * Math.PI * 4.3)), 2);
      const stress = 0.55 + 0.45 * Math.sin(t * 1.7 + Math.sin(t * 0.6) * 2);
      const level = talking * (0.18 + 0.82 * syllable * stress);
      signal.current.level = level;
      // A voice-like spectrum: energy low-mid, a moving "formant" bump.
      const formant = 2 + 1.5 * Math.sin(t * 2.3);
      for (let i = 0; i < 8; i++) {
        const shape = Math.exp(-((i - formant) ** 2) / 4) * 0.8 + 0.2 * Math.exp(-i / 3);
        signal.current.bands[i] = level * shape * (0.8 + 0.2 * Math.sin(t * 9 + i));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return signal;
}

/** The app's light/dark look, kept live (the theme switch lives in the sidebar). */
function useAppDark() {
  const read = () => document.documentElement.classList.contains("dark");
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

/**
 * Orb style choices as live previews: each tile runs the real orb with a pretend voice,
 * so you can see how it moves before picking. Black orb on the light theme, white on
 * dark, the same as on screen.
 */
export default function OrbStylePicker({ value, onChange }: { value: OrbVariant; onChange: (v: OrbVariant) => void }) {
  const signal = useFakeVoice();
  const appDark = useAppDark();
  return (
    <div className="orb-picker" role="radiogroup" aria-label="Orb style">
      {ORB_VARIANTS.map((v) => (
        <button
          key={v.id}
          type="button"
          role="radio"
          aria-checked={value === v.id}
          className={`orb-pick ${value === v.id ? "is-active" : ""}`}
          onClick={() => onChange(v.id)}
        >
          <span className="orb-pick-stage">
            <OrbBubble
              variant={v.id}
              status="recording"
              dark={!appDark}
              isError={false}
              cancelled={false}
              hovered={false}
              uiScale={1.35}
              signal={signal}
            />
          </span>
          <span className="orb-pick-label">{v.label.replace(" (default)", "")}</span>
        </button>
      ))}
    </div>
  );
}
