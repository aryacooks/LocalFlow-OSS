/**
 * Icon for the Dictionary: an open book with words on the left page and a tick on the
 * right, for "words it now gets right". Drawn in the current text colour for the accent
 * tile, like FormatIcon. The words write in, then the tick; hovering ticks it again (see
 * "Dictionary icon" in globals.css).
 */
export default function DictionaryIcon({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="dict-icon"
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
      <path d="M2 5.2c3-1.2 6.4-1 10 1.3 3.6-2.3 7-2.5 10-1.3v13.6c-3-1.2-6.4-1-10 1.3-3.6-2.3-7-2.5-10-1.3z" />
      <path d="M12 6.5v13.6" />
      <path className="di-word" d="M5 10h4" pathLength={1} />
      <path className="di-word di-word-2" d="M5 13.8h2.8" pathLength={1} />
      <path className="di-tick" d="M14.6 12.2l1.7 1.7 3.1-3.6" pathLength={1} />
    </svg>
  );
}
