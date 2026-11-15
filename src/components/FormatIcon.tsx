/**
 * Icon for Formatting options: a wavy line (words as spoken) above tidy lines (words as
 * typed), with a pen doing the tidying. Drawn in the current text colour so it sits in
 * the accent tile like the other icons. The tidy lines draw in once, and the pen nudges
 * on hover (see "Format icon" in globals.css).
 */
export default function FormatIcon({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="format-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path className="fi-wave" d="M3 5.5c1.7-2.2 3.3 2.2 5 0s3.3 2.2 5 0" />
      <path className="fi-line" d="M3 11h11" pathLength={1} />
      <path className="fi-line fi-line-2" d="M3 16.5h6.5" pathLength={1} />
      <g className="fi-pen">
        <path d="M18.6 10.4a1.8 1.8 0 0 1 2.6 2.6L14.6 19.6 11.5 20.5l.9-3.1z" />
        <path d="M17 12l2.6 2.6" />
      </g>
    </svg>
  );
}
