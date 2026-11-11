import { useEffect, useRef } from "react";

/**
 * OrbBubble — the on-screen animation: a small dot that grows into a voice-reactive orb
 * while you dictate. Variants were picked from design/orb-variants.html.
 *
 * Drawing happens in "points" around (0,0); 1 pt = 1 CSS px at uiScale 1. The canvas is
 * ORB_BOX pt square, centred in the window.
 */
export type OrbVariant = "sunburst" | "blob" | "orbit" | "liquid" | "pebble" | "minibars";
export const ORB_VARIANTS: { id: OrbVariant; label: string }[] = [
  { id: "blob", label: "Blob (default)" },
  { id: "sunburst", label: "Sunburst" },
  { id: "orbit", label: "Orbit" },
  { id: "liquid", label: "Liquid" },
  { id: "pebble", label: "Pebble" },
  { id: "minibars", label: "Mini bars" },
];
export const ORB_BOX = 64; // keep in sync with placement::ORB_BOX (Rust)
/** Active orbs draw a touch larger than the design page so they read at a glance. */
const GROW = 1.12;

export type OrbStatus = "idle" | "recording" | "processing" | "command" | "done";
type St = "idle" | "listening" | "processing" | "done";

export interface OrbSignal {
  level: number;     // 0..1 loudness target
  bands: number[];   // 8 band targets, 0..1
}

interface Props {
  variant: OrbVariant;
  status: OrbStatus;
  /** Black orb with white marks, or the inverse. */
  dark: boolean;
  isError: boolean;
  cancelled: boolean;
  hovered: boolean;
  uiScale: number;
  /** Latest audio targets; read every frame, so a ref rather than a prop. */
  signal: React.MutableRefObject<OrbSignal>;
}

const TAU = Math.PI * 2;
const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

interface Pal { body: string; mark: string; rim: string; shadow: string }
interface Snap { t: number; st: St; sp: number; lv: number; bands: number[]; a: number }

function disc(ctx: CanvasRenderingContext2D, r: number, fill: string, alpha = 1) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.beginPath(); ctx.arc(0, 0, Math.max(0, r), 0, TAU); ctx.fillStyle = fill; ctx.fill(); ctx.restore();
}
function withShadow(ctx: CanvasRenderingContext2D, p: Pal, fn: () => void) {
  ctx.save(); ctx.shadowColor = p.shadow; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2; fn(); ctx.restore();
}
function shadowDisc(ctx: CanvasRenderingContext2D, r: number, p: Pal) {
  withShadow(ctx, p, () => disc(ctx, r, p.body));
  ctx.save(); ctx.beginPath(); ctx.arc(0, 0, Math.max(0, r - 0.25), 0, TAU); ctx.strokeStyle = p.rim; ctx.lineWidth = 0.5; ctx.stroke(); ctx.restore();
}
function check(ctx: CanvasRenderingContext2D, prog: number, color: string, size = 6) {
  if (prog <= 0) return;
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.lineJoin = "round";
  const a = [-size * 0.8, 0], b = [-size * 0.2, size * 0.6], c = [size * 0.9, -size * 0.6];
  const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
  let d = ease(prog) * (l1 + l2);
  ctx.beginPath(); ctx.moveTo(a[0], a[1]);
  if (d <= l1) ctx.lineTo(a[0] + (b[0] - a[0]) * d / l1, a[1] + (b[1] - a[1]) * d / l1);
  else { ctx.lineTo(b[0], b[1]); d -= l1; ctx.lineTo(b[0] + (c[0] - b[0]) * d / l2, b[1] + (c[1] - b[1]) * d / l2); }
  ctx.stroke(); ctx.restore();
}
/** Done-state glyph: ✓, "!" for an error, ✕ for a cancel. */
function doneMark(ctx: CanvasRenderingContext2D, s: Snap, p: Pal, isError: boolean, cancelled: boolean) {
  if (isError) {
    ctx.save(); ctx.strokeStyle = "#ff6961"; ctx.lineWidth = 2.2; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(0, -4.5); ctx.lineTo(0, 1); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 4.6, 1.2, 0, TAU); ctx.fillStyle = "#ff6961"; ctx.fill(); ctx.restore();
    return;
  }
  if (cancelled) {
    const k = ease(s.sp * 3) * 4;
    ctx.save(); ctx.strokeStyle = p.mark; ctx.globalAlpha = 0.6; ctx.lineWidth = 2; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-k, -k); ctx.lineTo(k, k); ctx.moveTo(k, -k); ctx.lineTo(-k, k); ctx.stroke(); ctx.restore();
    return;
  }
  check(ctx, s.sp * 3, p.mark);
}
function idleDot(ctx: CanvasRenderingContext2D, p: Pal, hovered: boolean) {
  shadowDisc(ctx, hovered ? 8 : 6, p);
  disc(ctx, hovered ? 2.4 : 2, p.mark, 0.9);
}

/**
 * Transcribing looks the same for every style and deliberately unlike listening: the
 * orb settles to a calm, smaller disc (no voice wobble) and a ring spins inside it.
 * Drawn on the disc itself so it reads on any background.
 */
function transcribing(ctx: CanvasRenderingContext2D, s: Snap, p: Pal) {
  const k = ease(s.sp * 4); // settle in over ~250 ms
  const R = 15 - 2 * k;
  shadowDisc(ctx, R, p);
  const r = R - 4.5;
  ctx.save(); ctx.strokeStyle = p.mark; ctx.lineWidth = 2; ctx.lineCap = "round";
  ctx.globalAlpha = 0.22 * k; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
  ctx.globalAlpha = k;
  const a = s.t * TAU * 1.15;
  const len = TAU * (0.22 + 0.1 * Math.sin(s.t * 3));
  ctx.beginPath(); ctx.arc(0, 0, r, a, a + len); ctx.stroke();
  ctx.restore();
}

type Draw = (ctx: CanvasRenderingContext2D, s: Snap, p: Pal, mem: Record<string, number>, dt: number) => boolean | void;

// Each returns true when it has drawn the done state itself (else the caller does).
const DRAW: Record<OrbVariant, Draw> = {
  sunburst(ctx, s, p) {
    const R = 6 + 8 * s.a;
    shadowDisc(ctx, R + 6 * s.a, p);
    const n = 16;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * TAU - Math.PI / 2;
      const bi = Math.min(7, Math.abs(i - n / 2) % 8);
      const v = s.st === "listening" ? s.bands[bi] : s.st === "processing" ? 0.25 + 0.5 * Math.max(0, Math.sin(s.t * 8 - i * 0.6)) : 0;
      const r1 = R - 3, r2 = r1 + 1.5 + v * 5.5;
      ctx.save(); ctx.strokeStyle = p.mark; ctx.globalAlpha = (s.st === "done" ? 0 : 0.95) * s.a; ctx.lineWidth = 1.6; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(Math.cos(ang) * r1, Math.sin(ang) * r1); ctx.lineTo(Math.cos(ang) * r2, Math.sin(ang) * r2); ctx.stroke(); ctx.restore();
    }
    if (s.st !== "done") disc(ctx, 2.2, p.mark);
  },
  blob(ctx, s, p) {
    const R = 6 + 9 * s.a;
    const amp = s.st === "listening" ? 0.6 + s.lv * 4.2 : s.st === "processing" ? 1.2 : 0;
    withShadow(ctx, p, () => {
      ctx.beginPath();
      for (let i = 0; i <= 64; i++) {
        const th = (i / 64) * TAU;
        const r = R + amp * (0.55 * Math.sin(3 * th + s.t * 3.1) + 0.35 * Math.sin(5 * th - s.t * 4.3) + 0.25 * Math.sin(2 * th + s.t * 1.7));
        const x = Math.cos(th) * r, y = Math.sin(th) * r;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath(); ctx.fillStyle = p.body; ctx.fill();
    });
    ctx.save(); ctx.strokeStyle = p.rim; ctx.lineWidth = 0.6; ctx.stroke(); ctx.restore();
    if (s.st !== "done") disc(ctx, 3 + s.lv * 2 * (s.st === "listening" ? 1 : 0), p.mark);
  },
  orbit(ctx, s, p, mem, dt) {
    const R = 6 + 7 * s.a;
    const speed = s.st === "listening" ? 1.2 + s.lv * 9 : s.st === "processing" ? 7 : 0.6;
    mem.ang = (mem.ang ?? 0) + speed * dt;
    shadowDisc(ctx, R, p);
    if (s.st === "done") return;
    disc(ctx, 3, p.mark);
    // The moon circles OUTSIDE the orb, over whatever is behind it, so it is drawn in
    // the orb's own colour (which the adaptive tint keeps in contrast with the
    // background) with a shadow and a thin mark-coloured rim — never in the mark
    // colour, which would vanish on a matching background.
    const orbitR = R + 5.5;
    for (let k = 6; k >= 1; k--) {
      const a = mem.ang - k * 0.1 * (speed / 6);
      ctx.save(); ctx.globalAlpha = (0.55 - k * 0.07) * s.a;
      ctx.beginPath(); ctx.arc(Math.cos(a) * orbitR, Math.sin(a) * orbitR, 2.6 - k * 0.25, 0, TAU);
      ctx.fillStyle = p.body; ctx.fill(); ctx.restore();
    }
    const mx = Math.cos(mem.ang) * orbitR, my = Math.sin(mem.ang) * orbitR;
    ctx.save(); ctx.globalAlpha = s.a;
    withShadow(ctx, p, () => { ctx.beginPath(); ctx.arc(mx, my, 3, 0, TAU); ctx.fillStyle = p.body; ctx.fill(); });
    ctx.beginPath(); ctx.arc(mx, my, 3, 0, TAU); ctx.strokeStyle = p.mark; ctx.globalAlpha = 0.5 * s.a; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.restore();
  },
  liquid(ctx, s, p) {
    const R = 6 + 10 * s.a;
    shadowDisc(ctx, R, p);
    if (s.st === "done") return;
    const fill = s.st === "listening" ? 0.18 + s.lv * 0.62 : 0.35 + 0.08 * Math.sin(s.t * 3);
    const surf = R - fill * 2 * R;
    ctx.save(); ctx.beginPath(); ctx.arc(0, 0, R - 1.5, 0, TAU); ctx.clip();
    ctx.beginPath(); ctx.moveTo(-R, R);
    for (let x = -R; x <= R; x += 1) ctx.lineTo(x, surf + Math.sin(x * 0.45 + s.t * 7) * (1 + s.lv * 2.2) + Math.sin(x * 0.9 - s.t * 5) * 0.6);
    ctx.lineTo(R, R); ctx.closePath(); ctx.globalAlpha = 0.92; ctx.fillStyle = p.mark; ctx.fill(); ctx.restore();
  },
  pebble(ctx, s, p) {
    const w = s.st === "listening" ? 14 + s.lv * 16 : s.st === "processing" ? 14 + 6 * Math.sin(s.t * 6) : 26;
    const h = 26 * s.a + 6;
    withShadow(ctx, p, () => {
      ctx.beginPath(); ctx.roundRect(-w / 2 - 6 * s.a, -h / 2, w + 12 * s.a, h, h / 2); ctx.fillStyle = p.body; ctx.fill();
    });
    if (s.st === "done") return;
    const iw = Math.max(5, w - 8);
    ctx.beginPath(); ctx.roundRect(-iw / 2, -2.6, iw, 5.2, 2.6); ctx.fillStyle = p.mark; ctx.fill();
  },
  minibars(ctx, s, p) {
    const R = 6 + 10 * s.a;
    shadowDisc(ctx, R, p);
    if (s.st === "done") return;
    const map = [6, 3, 0, 3, 6];
    for (let i = 0; i < 5; i++) {
      const v = s.st === "listening" ? s.bands[map[i]] * (1 - Math.abs(i - 2) * 0.12) : 0.2 + 0.45 * Math.max(0, Math.sin(s.t * 8 - i * 0.7));
      const h = 2.5 + v * 13 * s.a, x = (i - 2) * 4;
      ctx.beginPath(); ctx.roundRect(x - 1.1, -h / 2, 2.2, h, 1.1); ctx.fillStyle = p.mark; ctx.fill();
    }
  },
};

export default function OrbBubble({ variant, status, dark, isError, cancelled, hovered, uiScale, signal }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Everything the animation loop needs, kept in a ref so the loop never restarts.
  const live = useRef({ variant, status, dark, isError, cancelled, hovered, uiScale });
  live.current = { variant, status, dark, isError, cancelled, hovered, uiScale };
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    let raf = 0, running = false, last = performance.now(), stateAt = last / 1000;
    let prevSt: St = "idle";
    let level = 0, active = 0;
    const bands = new Array(8).fill(0);
    const mem: Record<string, number> = {};
    let lastSize = 0;

    const frame = (now: number) => {
      const L = live.current;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const t = now / 1000;
      const st: St =
        L.status === "recording" || L.status === "command" ? "listening"
        : L.status === "processing" ? "processing"
        : L.status === "done" ? "done" : "idle";
      if (st !== prevSt) { prevSt = st; stateAt = t; }

      // Fast attack, slow release: reads like a voice rather than a meter.
      const target = st === "listening" ? signal.current.level : 0;
      level += (target - level) * (target > level ? 1 - Math.exp(-dt / 0.045) : 1 - Math.exp(-dt / 0.16));
      for (let i = 0; i < 8; i++) {
        const tb = st === "listening" ? (signal.current.bands[i] ?? 0) : 0;
        bands[i] += (tb - bands[i]) * (tb > bands[i] ? 1 - Math.exp(-dt / 0.04) : 1 - Math.exp(-dt / 0.14));
      }
      active += ((st === "idle" ? 0 : 1) - active) * (1 - Math.exp(-dt / 0.09));

      // Keep the backing store matched to size × DPR.
      const dpr = window.devicePixelRatio || 1;
      const px = Math.round(ORB_BOX * L.uiScale * dpr);
      if (px !== lastSize) { cv.width = px; cv.height = px; lastSize = px; }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.setTransform(dpr * L.uiScale, 0, 0, dpr * L.uiScale, cv.width / 2, cv.height / 2);

      const pal: Pal = L.dark
        ? { body: "#0b0b0c", mark: L.status === "command" ? "#c4b0ff" : "#ffffff", rim: "rgba(255,255,255,.24)", shadow: "rgba(0,0,0,.4)" }
        : { body: "#ffffff", mark: L.status === "command" ? "#7c5cff" : "#0b0b0c", rim: "rgba(0,0,0,.18)", shadow: "rgba(0,0,0,.3)" };

      if (active < 0.05 && st === "idle") {
        idleDot(ctx, pal, L.hovered);
        // Settled at idle: stop the loop (no 60 fps redraws all day). Any prop change
        // kicks it again.
        if (active < 0.01) { running = false; return; }
      } else {
        const snap: Snap = { t, st, sp: t - stateAt, lv: level, bands, a: active };
        ctx.scale(GROW, GROW);
        if (st === "processing") transcribing(ctx, snap, pal);
        else DRAW[L.variant](ctx, snap, pal, mem, dt);
        if (st === "done") doneMark(ctx, snap, pal, L.isError, L.cancelled);
      }
      raf = requestAnimationFrame(frame);
    };
    kick.current = () => {
      if (running) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    kick.current();
    return () => { running = false; cancelAnimationFrame(raf); kick.current = () => {}; };
  }, [signal]);

  useEffect(() => { kick.current(); }, [variant, status, dark, isError, cancelled, hovered, uiScale]);

  const size = ORB_BOX * uiScale;
  return <canvas ref={canvasRef} style={{ width: size, height: size, display: "block" }} />;
}
