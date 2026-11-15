/**
 * Icons for the Dashboard's recording-limit notes, drawn like FormatIcon and
 * DictionaryIcon: current text colour, 2px rounded strokes, a small draw-in on mount
 * and a nudge on hover (see "Limit icons" in globals.css).
 */
const svgProps = {
  width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
} as const;

/** 10 min max: a voice wave with a cut line; only the part after the cut is kept. */
export function TrimIcon() {
  return (
    <svg className="limit-svg li-trim" {...svgProps}>
      <path className="li-old" d="M3 11v2M6 9v6" />
      <path className="li-cut" d="M9 3.5v17" strokeDasharray="2.2 2.6" />
      <path className="li-bar" d="M12.5 8v8" pathLength={1} />
      <path className="li-bar li-bar-2" d="M16 5v14" pathLength={1} />
      <path className="li-bar li-bar-3" d="M19.5 9.5v5" pathLength={1} />
    </svg>
  );
}

/** Longer talk, longer wait: a speech bubble whose words arrive one dot at a time. */
export function WaitIcon() {
  return (
    <svg className="limit-svg li-wait" {...svgProps}>
      <path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-9l-4.5 3.5v-3.5H4A1.5 1.5 0 0 1 2.5 16V7A1.5 1.5 0 0 1 4 5.5z" />
      <path className="li-dot" d="M8 11.5h.01" strokeWidth={3} />
      <path className="li-dot li-dot-2" d="M12 11.5h.01" strokeWidth={3} />
      <path className="li-dot li-dot-3" d="M16 11.5h.01" strokeWidth={3} />
    </svg>
  );
}

/** Memory frees itself: a memory chip with the model lifting out of it. */
export function FreeIcon() {
  return (
    <svg className="limit-svg li-free" {...svgProps}>
      <path d="M3.5 14h17v5.5h-17z" />
      <path d="M7 19.5v1.5M12 19.5v1.5M17 19.5v1.5" />
      <g className="li-lift">
        <path d="M12 10.5V3" />
        <path d="M8.5 6.2 12 2.8l3.5 3.4" />
      </g>
    </svg>
  );
}
