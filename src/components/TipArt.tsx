import type { ReactNode } from "react";

/**
 * Small looping line-art scenes for the Tips page, one per tip. Each is a 160×90 SVG
 * drawn in the theme's ink with one tone colour; all motion is CSS (see "Tip art" in
 * globals.css). Classes: `i` ink stroke, `n` paper-filled node, `t` tone fill,
 * `k` ink fill, `tx` label text, and `a-*` for the animations.
 */

const Key = ({ x, y, w = 40, label, cls = "" }: { x: number; y: number; w?: number; label: string; cls?: string }) => (
  <>
    <rect className="k" x={x} y={y + 5} width={w} height={34} rx={7} />
    <g className={cls}>
      <rect className="n" x={x} y={y} width={w} height={34} rx={7} />
      <text className="tx" x={x + w / 2} y={y + 22}>{label}</text>
    </g>
  </>
);

/** Voice bars centred on (x, y). `cls` picks the timing. */
const Bars = ({ x, y, cls, n = 5 }: { x: number; y: number; cls: string; n?: number }) => (
  <>
    {Array.from({ length: n }, (_, j) => (
      <rect
        key={j}
        className={`k ${cls}`}
        x={x + j * 8}
        y={y - 11}
        width={4}
        height={22}
        rx={2}
        style={{ animationDelay: `${j * 0.12}s`, ["--h" as string]: [0.5, 1, 0.7, 0.95, 0.45][j % 5] }}
      />
    ))}
  </>
);

const ART: Record<string, ReactNode> = {
  // Right-click the orb: a menu pops out of it.
  orbmenu: (
    <>
      <circle className="n" cx="46" cy="47" r="14" />
      <circle className="t a-breathe" cx="46" cy="47" r="7" />
      <path className="k a-nudge" d="M56 53l11 4-4.5 2-2 4.5z" />
      <g className="a-pop" style={{ transformOrigin: "74px 30px" }}>
        <rect className="n" x="74" y="22" width="52" height="48" rx="7" />
        <rect className="t" x="80" y="29" width="40" height="10" rx="3" />
        <path className="i" d="M82 48h30M82 59h22" />
      </g>
    </>
  ),
  // Click it while talking: bars inside the orb, a ripple when it finishes.
  clicktalk: (
    <>
      <circle className="ts a-ripple" cx="80" cy="45" r="24" />
      <circle className="n" cx="80" cy="45" r="24" />
      <Bars x={66} y={45} cls="a-bar" n={4} />
    </>
  ),
  // Drag it: the orb hops between the spots around the screen.
  place: (
    <>
      <rect className="i" x="28" y="14" width="104" height="62" rx="7" />
      {[[40, 26], [80, 26], [120, 26], [40, 45], [120, 45], [40, 64], [80, 64], [120, 64]].map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} className="dot" cx={cx} cy={cy} r="2.5" />
      ))}
      <g className="a-hop">
        <circle className="n" cx="40" cy="26" r="8" />
        <circle className="t" cx="40" cy="26" r="4" />
      </g>
    </>
  ),
  // The notch island grows out of the notch.
  notch: (
    <>
      <rect className="i" x="24" y="16" width="112" height="60" rx="7" />
      <rect className="k a-notch" x="66" y="16" width="28" height="9" rx="4.5" style={{ transformOrigin: "80px 16px" }} />
      <path className="i faint" d="M40 46h80M40 58h54" />
    </>
  ),
  // Hold Fn: the key goes down, bars run while it is held.
  holdfn: (
    <>
      <Key x={28} y={26} label="fn" cls="a-hold" />
      <Bars x={88} y={45} cls="a-barhold" />
    </>
  ),
  // Double-tap: two quick presses, then it keeps listening.
  doubletap: (
    <>
      <Key x={28} y={26} label="fn" cls="a-tap2" />
      <circle className="ts a-lockring" cx="108" cy="45" r="20" />
      <Bars x={90} y={45} cls="a-barfree" />
    </>
  ),
  // Your own shortcuts: keys and a mouse button light up in turn.
  shortcuts: (
    <>
      <rect className="t a-seq" x="22" y="28" width="34" height="34" rx="7" />
      <rect className="i" x="22" y="28" width="34" height="34" rx="7" />
      <text className="tx" x="39" y="50">⌥</text>
      <rect className="t a-seq" x="62" y="28" width="34" height="34" rx="7" style={{ animationDelay: "1.2s" }} />
      <rect className="i" x="62" y="28" width="34" height="34" rx="7" />
      <text className="tx" x="79" y="50">F</text>
      <path className="t a-seq" d="M112 30h14v16h-14z" style={{ animationDelay: "2.4s" }} />
      <rect className="i" x="112" y="24" width="28" height="44" rx="14" />
      <path className="i" d="M126 24v22M112 46h28" />
    </>
  ),
  // 10 minutes: the hand sweeps, the ring fills.
  timer: (
    <>
      <circle className="n" cx="80" cy="47" r="25" />
      <circle className="ts thick a-ring" cx="80" cy="47" r="25" pathLength={100} transform="rotate(-90 80 47)" />
      <path className="i a-sweep" d="M80 47V29" style={{ transformOrigin: "80px 47px" }} />
      <circle className="k" cx="80" cy="47" r="2.5" />
      <path className="i" d="M74 16h12" />
    </>
  ),
  // Punctuation: marks land at the end of the lines.
  punct: (
    <>
      <path className="i" d="M30 30h52" />
      <text className="tx big a-drop" x="92" y="35">,</text>
      <path className="i" d="M30 48h70" />
      <text className="tx big a-drop" x="110" y="54" style={{ animationDelay: ".7s" }}>?</text>
      <path className="i" d="M30 66h36" />
      <path className="ts a-drop" d="M112 60v6H96m5-5-5 5 5 5" style={{ animationDelay: "1.4s" }} />
    </>
  ),
  // Take it back: a line is written, wiped, and rewritten.
  undo: (
    <>
      <path className="i" d="M30 32h74" />
      <path className="i a-wipe" d="M30 50h86" pathLength={100} />
      <rect className="t a-redo" x="30" y="45" width="52" height="10" rx="5" />
      <path className="ts a-undo" d="M126 62a12 12 0 1 0-12-12m0-8v8h8" style={{ transformOrigin: "126px 50px" }} />
    </>
  ),
  // Spoken emoji: the words turn into a face.
  emoji: (
    <>
      <path className="n" d="M34 22h92a7 7 0 0 1 7 7v30a7 7 0 0 1-7 7H70l-12 10v-10H34a7 7 0 0 1-7-7V29a7 7 0 0 1 7-7z" />
      <g className="a-swap-a"><path className="i" d="M40 38h50M40 50h34" /></g>
      <g className="a-swap-b" style={{ transformOrigin: "80px 44px" }}>
        <circle className="t" cx="80" cy="44" r="15" />
        <circle className="i" cx="80" cy="44" r="15" />
        <circle className="k" cx="74.5" cy="40" r="2" />
        <circle className="k" cx="85.5" cy="40" r="2" />
        <path className="i" d="M73 48a8 8 0 0 0 14 0" />
      </g>
    </>
  ),
  // Dictionary: the misheard word is struck out and replaced.
  dictionary: (
    <>
      {[28, 56].map((y, r) => (
        <g key={y}>
          <path className="i faint" d={`M26 ${y}h${r ? 34 : 44}`} />
          <path className="ts a-strike" d={`M22 ${y}h${r ? 42 : 52}`} pathLength={100} style={{ animationDelay: `${r * 0.9}s` }} />
          <path className="i" d={`M84 ${y}h10m-4-4 4 4-4 4`} />
          <rect className="t a-fix" x="102" y={y - 6} width={r ? 30 : 36} height="12" rx="6" style={{ animationDelay: `${r * 0.9}s` }} />
        </g>
      ))}
    </>
  ),
  // Formatting: scattered lines settle into tidy ones.
  formatting: (
    <>
      {[[26, 44, 14], [40, 30, -10], [54, 52, 18], [68, 26, -16]].map(([y, w, dx]) => (
        <rect key={y} className="k a-tidy" x="38" y={y - 2} width={w + 28} height="4" rx="2" style={{ ["--dx" as string]: `${dx}px`, ["--r" as string]: `${dx / 3}deg` }} />
      ))}
      <path className="t a-spark" d="M124 22l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" style={{ transformOrigin: "124px 33px" }} />
    </>
  ),
  // Nowhere to type: a card rises with a Copy button.
  pastecard: (
    <>
      <rect className="i faint dash" x="24" y="14" width="112" height="24" rx="6" />
      <g className="a-rise">
        <rect className="n" x="36" y="40" width="88" height="40" rx="7" />
        <path className="i" d="M46 52h52M46 62h30" />
        <rect className="t a-press" x="96" y="60" width="20" height="12" rx="4" />
      </g>
    </>
  ),
  // Incognito: a ghost floats while history stays empty.
  incognito: (
    <>
      <g className="a-float">
        <path className="n" d="M40 68V42a15 15 0 0 1 30 0v26l-5-4.5-5 4.5-5-4.5-5 4.5-5-4.5z" />
        <circle className="k" cx="50" cy="42" r="2.2" />
        <circle className="k" cx="60" cy="42" r="2.2" />
      </g>
      {[30, 46, 62].map((y, j) => (
        <path key={y} className="i dash a-vanish" d={`M88 ${y}h${[44, 30, 38][j]}`} style={{ animationDelay: `${j * 0.35}s` }} />
      ))}
    </>
  ),
  // Closing isn't quitting: the window goes, the orb stays.
  quit: (
    <>
      <g className="a-winclose" style={{ transformOrigin: "72px 42px" }}>
        <rect className="n" x="26" y="16" width="92" height="54" rx="7" />
        <path className="i" d="M26 30h92" />
        <circle className="k" cx="36" cy="23" r="2.5" />
        <path className="i faint" d="M38 44h56M38 56h36" />
      </g>
      <circle className="ts a-ripple" cx="128" cy="66" r="10" />
      <circle className="n" cx="128" cy="66" r="10" />
      <circle className="t a-breathe" cx="128" cy="66" r="5" />
    </>
  ),
  // Make it yours: the swatch flips between looks.
  theme: (
    <>
      <g className="a-flip" style={{ transformOrigin: "80px 40px" }}>
        <circle className="n" cx="80" cy="40" r="22" />
        <path className="k" d="M80 18a22 22 0 0 1 0 44z" />
      </g>
      {[62, 80, 98].map((cx, j) => (
        <circle key={cx} className="t a-seq ring" cx={cx} cy="76" r="5" style={{ animationDelay: `${j * 1.2}s` }} />
      ))}
    </>
  ),
  // Voice snippets: a short phrase turns into a full block of text.
  snippets: (
    <>
      <g className="a-pop" style={{ transformOrigin: "40px 40px" }}>
        <path className="n" d="M20 26h40a6 6 0 0 1 6 6v14a6 6 0 0 1-6 6H36l-8 7v-7h-8a6 6 0 0 1-6-6V32a6 6 0 0 1 6-6z" />
        <path className="i" d="M26 39h28" />
      </g>
      <path className="i" d="M74 40h10m-4-4 4 4-4 4" />
      <g className="a-rise">
        <rect className="n" x="94" y="18" width="48" height="46" rx="7" />
        <rect className="t a-fix" x="100" y="26" width="36" height="7" rx="3.5" />
        <path className="i" d="M101 43h32M101 53h22" />
      </g>
    </>
  ),
  // Check audio levels: the meter climbs into the green.
  miccheck: (
    <>
      <rect className="n" x="22" y="18" width="116" height="40" rx="8" />
      <Bars x={48} y={38} cls="a-bar" n={8} />
      <rect className="n" x="22" y="66" width="116" height="10" rx="5" />
      <rect className="t a-fix" x="24" y="68" width="74" height="6" rx="3" />
    </>
  ),
  // System audio: sound from the speaker becomes text.
  sysaudio: (
    <>
      <path className="n" d="M26 36h10l14-11v40L36 54H26z" />
      <path className="i a-breathe" d="M58 34a10 10 0 0 1 0 22" style={{ transformOrigin: "58px 45px" }} />
      <path className="i a-breathe" d="M65 27a20 20 0 0 1 0 36" style={{ transformOrigin: "58px 45px", animationDelay: ".3s" }} />
      <path className="i" d="M84 45h10m-4-4 4 4-4 4" />
      {[32, 45, 58].map((y, j) => (
        <rect key={y} className="t a-fix" x="104" y={y - 3} width={[34, 26, 30][j]} height="6" rx="3" style={{ animationDelay: `${j * 0.3}s` }} />
      ))}
    </>
  ),
  // Music pauses while you talk: the note waits, the bars talk.
  music: (
    <>
      <g className="a-float">
        <path className="i" d="M48 60V26l22-5v32" />
        <circle className="n" cx="42" cy="60" r="7" />
        <circle className="n" cx="64" cy="54" r="7" />
      </g>
      <rect className="t" x="86" y="30" width="7" height="26" rx="2" />
      <rect className="t" x="99" y="30" width="7" height="26" rx="2" />
      <Bars x={116} y={43} cls="a-bar" n={3} />
    </>
  ),
  // Lock History: a padlock over the list.
  lock: (
    <>
      {[26, 42, 58].map((y) => (
        <path key={y} className="i faint" d={`M24 ${y}h56`} />
      ))}
      <g className="a-pop" style={{ transformOrigin: "112px 46px" }}>
        <path className="i" d="M101 40v-8a11 11 0 0 1 22 0v8" />
        <rect className="n" x="96" y="40" width="32" height="28" rx="6" />
        <circle className="t a-breathe" cx="112" cy="54" r="4" />
      </g>
    </>
  ),
  // Hidden when sharing your screen: you see the orb, the call doesn't.
  share: (
    <>
      <rect className="n" x="16" y="18" width="58" height="42" rx="6" />
      <circle className="t" cx="62" cy="50" r="5" />
      <rect className="n" x="86" y="18" width="58" height="42" rx="6" />
      <circle className="i dash a-vanish" cx="132" cy="50" r="5" />
      <path className="i" d="M45 72h70" />
      <path className="i" d="M76 39h8m-3-3 3 3-3 3" />
    </>
  ),
  // Auto-delete history: a clock, and old lines fade away one by one.
  autodelete: (
    <>
      <circle className="n" cx="42" cy="45" r="20" />
      <path className="i" d="M42 33v12l8 5" />
      {[28, 45, 62].map((y, j) => (
        <path key={y} className="i dash a-vanish" d={`M78 ${y}h${[56, 44, 50][j]}`} style={{ animationDelay: `${j * 0.4}s` }} />
      ))}
    </>
  ),
  // Don't save from these apps: an app tile with a "not saved" slash.
  nosave: (
    <>
      <rect className="n" x="30" y="22" width="44" height="44" rx="11" />
      <circle className="t" cx="52" cy="44" r="10" />
      <path className="i" d="M86 44h10m-4-4 4 4-4 4" />
      <rect className="n" x="106" y="26" width="30" height="36" rx="5" />
      <path className="i faint" d="M112 36h18M112 46h12" />
      <path className="ts thick a-pop" d="M104 66l34-44" style={{ transformOrigin: "121px 44px" }} />
    </>
  ),
  // Orb transparency: the same orb, more and more see-through.
  transparency: (
    <>
      <path className="i faint" d="M20 30h120M20 45h120M20 60h120" />
      {[44, 80, 116].map((cx, j) => (
        <g key={cx} style={{ opacity: [1, 0.6, 0.3][j] }}>
          <circle className="n" cx={cx} cy="45" r="13" />
          <circle className="t a-breathe" cx={cx} cy="45" r="6" style={{ animationDelay: `${j * 0.3}s` }} />
        </g>
      ))}
    </>
  ),
  // Full-screen apps: the orb slides down to the real bottom edge.
  fullscreen: (
    <>
      <rect className="n" x="22" y="12" width="116" height="66" rx="6" />
      <path className="i faint" d="M34 30h60M34 42h44" />
      <circle className="i dash" cx="122" cy="52" r="6" />
      <g className="a-rise">
        <circle className="n" cx="122" cy="68" r="6" />
        <circle className="t" cx="122" cy="68" r="3" />
      </g>
    </>
  ),
  // Esc cancels: press Esc and the line is dropped.
  esc: (
    <>
      <Key x={24} y={26} w={46} label="esc" cls="a-hold" />
      <path className="i a-vanish" d="M86 38h48" />
      <path className="i a-vanish" d="M86 52h32" style={{ animationDelay: ".3s" }} />
    </>
  ),
};

export default function TipArt({ name }: { name: string }) {
  return (
    <svg className="tipart-svg" viewBox="0 0 160 90" role="img" aria-hidden="true">
      {ART[name]}
    </svg>
  );
}
