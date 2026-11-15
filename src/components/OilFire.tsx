import { useEffect, useRef } from "react";
import { useAppStore } from "../lib/store";

/**
 * A small particle fire for the bottom of a card, shown only in the Oil theme:
 * warm orange flames in light mode, blue flames in dark mode. Drawn on a canvas; pauses when the window is hidden and stays off with reduced motion.
 */

// Colour ramp from the hot core (life 0) to the cooling tip (life 1).
const RAMPS: Record<"warm" | "blue", [number, number, number][]> = {
  warm: [
    [255, 238, 150],
    [255, 150, 30],
    [238, 84, 20],
    [190, 40, 18],
    [110, 22, 14],
  ],
  blue: [
    [225, 246, 255],
    [110, 200, 255],
    [40, 120, 245],
    [36, 62, 200],
    [28, 26, 110],
  ],
};

function rampColor(ramp: [number, number, number][], t: number): [number, number, number] {
  const x = Math.min(0.999, Math.max(0, t)) * (ramp.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = ramp[i];
  const b = ramp[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
  decay: number;
  seed: number;
}

export default function OilFire() {
  const look = useAppStore((s) => s.look);
  const theme = useAppStore((s) => s.theme);
  const ref = useRef<HTMLCanvasElement>(null);
  const on = look === "oil";

  useEffect(() => {
    if (!on) return;
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const ramp = RAMPS[theme === "dark" ? "blue" : "warm"];

    let w = 0, h = 0, raf = 0, t = 0;
    const sparks: Spark[] = [];

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const spawn = () => {
      // Denser in the middle, tapering to the card's edges.
      const u = (Math.random() + Math.random() + Math.random()) / 3;
      const base = Math.max(14, w / 9);
      sparks.push({
        x: u * w,
        y: h + 6,
        vx: (Math.random() - 0.5) * 0.35,
        vy: -(0.7 + Math.random() * 1.1) * (h / 120),
        r: base * (0.55 + Math.random() * 0.6),
        life: 0,
        decay: 0.009 + Math.random() * 0.01,
        seed: Math.random() * 1000,
      });
    };

    const frame = () => {
      t += 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, w, h);

      const perFrame = Math.max(2, Math.round(w / 70));
      for (let i = 0; i < perFrame; i++) spawn();

      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.life += s.decay;
        if (s.life >= 1) {
          sparks.splice(i, 1);
          continue;
        }
        // Flicker sideways, pull toward the centre as the flame narrows.
        s.x += s.vx + Math.sin((t + s.seed) * 0.09) * 0.45 + (w / 2 - s.x) * 0.004;
        s.y += s.vy;
        const r = s.r * (1 - s.life * 0.85);
        const [cr, cg, cb] = rampColor(ramp, s.life);
        const alpha = Math.min(1, (1 - s.life) * 1.1) * 0.5;
        const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 1.35);
        g.addColorStop(0, `rgba(${cr | 0},${cg | 0},${cb | 0},${alpha})`);
        g.addColorStop(1, `rgba(${cr | 0},${cg | 0},${cb | 0},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        // Taller than wide, so the blobs read as tongues of flame.
        ctx.ellipse(s.x, s.y, r * 0.75, r * 1.35, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // Occasional embers drifting up.
      if (Math.random() < 0.25) {
        const [er, eg, eb] = rampColor(ramp, 0.25);
        ctx.fillStyle = `rgba(${er | 0},${eg | 0},${eb | 0},0.9)`;
        ctx.fillRect(Math.random() * w, h * (0.2 + Math.random() * 0.6), 1.6, 1.6);
      }

    };

    const tick = () => {
      frame();
      if (!document.hidden) raf = requestAnimationFrame(tick);
    };

    const onVisible = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !reduced) raf = requestAnimationFrame(tick);
    };

    if (reduced) {
      // One still frame of flames.
      for (let i = 0; i < 90; i++) frame();
    } else {
      raf = requestAnimationFrame(tick);
      document.addEventListener("visibilitychange", onVisible);
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [on, theme]);

  if (!on) return null;
  return <canvas ref={ref} className="oil-fire" aria-hidden="true" />;
}
