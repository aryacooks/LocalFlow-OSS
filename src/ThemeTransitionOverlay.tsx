import { useEffect, useMemo } from "react";
import { useAppStore } from "./lib/store";

const SIZE = 32; // px per pixel-square
const TOTAL = 750; // total dissolve duration
const SQUARE_DUR = 280; // each square's own fall duration

// Each theme's background — matches the --window tokens in globals.css.
const THEME_BG: Record<"dark" | "light", string> = {
  dark: "#151914",
  light: "#FFFFEB",
};

function hexToRgb(hex: string) {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

// Slightly randomize a square's brightness so the grid reads as distinct pixels
// (digital static) instead of one flat sheet.
function jitterColor(rgb: number[]): string {
  const m = 0.88 + Math.random() * 0.26; // 0.88–1.14
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * m)));
  return `rgb(${c(rgb[0])}, ${c(rgb[1])}, ${c(rgb[2])})`;
}

/**
 * Theme-switch transition: a grid of small squares painted in (jittered) OLD-theme
 * colors covers the screen, then each square scatters away — dropping, drifting,
 * spinning, shrinking, and fading — in a ragged diagonal wave from the top-right
 * toward the bottom-left, revealing the new theme underneath. Per-square color and
 * motion variation make it read as shattering pixels rather than a sliding sheet.
 */
export default function ThemeTransitionOverlay() {
  const transition = useAppStore((s) => s.themeTransition);
  if (!transition) return null;
  return <PixelFall key={transition.id} from={transition.from} />;
}

interface Tile {
  delay: number;
  bg: string;
  dx: number; // horizontal drift (px)
  dy: number; // fall distance (px)
  rot: number; // end rotation (deg)
  sc: number; // end scale
}

function PixelFall({ from }: { from: "dark" | "light" }) {
  const endThemeTransition = useAppStore((s) => s.endThemeTransition);

  // Build the grid (and all per-square randomness) once for this run.
  const { cols, tiles } = useMemo(() => {
    const cols = Math.ceil(window.innerWidth / SIZE);
    const rows = Math.ceil(window.innerHeight / SIZE);
    const maxDist = cols - 1 + (rows - 1);
    const step = maxDist > 0 ? (TOTAL - SQUARE_DUR) / maxDist : 0;
    const rgb = hexToRgb(THEME_BG[from]);

    const tiles: Tile[] = [];
    for (let i = 0; i < cols * rows; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      // 0 at the top-right corner, growing toward the bottom-left, plus jitter so the
      // wave edge is ragged instead of a ruler-straight diagonal.
      const dist = cols - 1 - col + row;
      const delay = Math.max(0, dist * step + (Math.random() - 0.5) * 70);
      tiles.push({
        delay,
        bg: jitterColor(rgb),
        dx: (Math.random() - 0.5) * 44, // ±22px sideways scatter
        dy: 64 + Math.random() * 48, // 64–112px fall
        rot: (Math.random() - 0.5) * 60, // ±30° spin
        sc: 0.32 + Math.random() * 0.26, // shrink to 0.32–0.58
      });
    }
    return { cols, tiles };
  }, [from]);

  useEffect(() => {
    const t = setTimeout(endThemeTransition, TOTAL + SQUARE_DUR + 120);
    return () => clearTimeout(t);
  }, [endThemeTransition]);

  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        pointerEvents: "none",
        overflow: "hidden",
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, ${SIZE}px)`,
        gridAutoRows: `${SIZE}px`,
      }}
    >
      {tiles.map((t, i) => (
        <div
          key={i}
          style={
            {
              background: t.bg,
              willChange: "transform, opacity",
              animation: `pixelFall ${SQUARE_DUR}ms cubic-bezier(0.55, 0, 0.85, 0.3) ${t.delay}ms forwards`,
              "--dx": `${t.dx}px`,
              "--dy": `${t.dy}px`,
              "--rot": `${t.rot}deg`,
              "--sc": t.sc,
            } as React.CSSProperties
          }
        />
      ))}
      <style>{`
        @keyframes pixelFall {
          0%   { transform: translate(0, 0) rotate(0deg) scale(1); opacity: 1; }
          50%  { opacity: 1; }
          100% { transform: translate(var(--dx), var(--dy)) rotate(var(--rot)) scale(var(--sc)); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
