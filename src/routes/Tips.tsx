import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import TipArt from "../components/TipArt";

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

interface Tip {
  /** Which looping scene to draw (see TipArt). */
  art: string;
  tone: string;
  title: string;
  body: ReactNode;
}

interface Group {
  label: string;
  tips: Tip[];
}

const K = ({ children }: { children: ReactNode }) => <kbd className="keycap tips-key">{children}</kbd>;
const Say = ({ children }: { children: ReactNode }) => <span className="tips-say">"{children}"</span>;

const GREEN = "#2e9e5b";
const ORANGE = "#e0662a";
const GOLD = "#c9891a";
const VIOLET = "#6d5bd0";

const GROUPS: Group[] = [
  {
    label: "The orb",
    tips: [
      { art: "orbmenu", tone: ORANGE, title: "Right-click the orb", body: <>Opens its menu: <b>Incognito</b>, <b>Sounds</b>, <b>Hide</b>, <b>Open</b> the app or <b>Quit</b>.</> },
      { art: "clicktalk", tone: GREEN, title: "Click it while talking", body: <>Finishes the dictation and types it, the same as letting go of your shortcut.</> },
      { art: "place", tone: GOLD, title: "Drag it anywhere", body: <>It snaps to the nearest of 8 spots. Or click it when idle and pick one. <K>Esc</K> cancels.</> },
      ...(IS_MAC
        ? [{ art: "notch", tone: VIOLET, title: "Prefer the notch?", body: <>In <b>Settings</b>, turn the orb into an island that grows out of the notch, or hide it.</> }]
        : []),
      { art: "transparency", tone: GREEN, title: "See through the orb", body: <>Make it fainter with <b>Orb transparency</b> so it gets in the way less.</> },
      ...(IS_MAC
        ? [{ art: "fullscreen", tone: ORANGE, title: "Works in full screen", body: <>The orb follows you into full-screen apps and every desktop, sitting at the real screen edge.</> }]
        : []),
    ],
  },
  {
    label: "Talking",
    tips: [
      ...(IS_MAC
        ? [
            { art: "holdfn", tone: GREEN, title: "Hold Fn to talk", body: <>Hold <K>Fn</K>, speak, let go. Your words are typed wherever your cursor is.</> },
            { art: "doubletap", tone: ORANGE, title: "Double-tap for hands-free", body: <>Tap <K>Fn</K> twice and talk as long as you like. Tap once more to stop.</> },
          ]
        : [{ art: "esc", tone: ORANGE, title: "Esc cancels", body: <>Changed your mind mid-sentence? Press <K>Esc</K> and nothing gets typed.</> }]),
      { art: "shortcuts", tone: VIOLET, title: "Your own shortcuts", body: <>On <b>Shortcuts</b>, pick any key combo to toggle or hold, even the side buttons on your mouse.</> },
      { art: "timer", tone: GOLD, title: "No time limit", body: <>Talk for as long as you like. Long recordings are typed out in one go when you stop.</> },
    ],
  },
  {
    label: "Say it, and it happens",
    tips: [
      { art: "punct", tone: GREEN, title: "Punctuation and lines", body: <>Say <Say>comma</Say>, <Say>question mark</Say>, <Say>new line</Say> or <Say>new paragraph</Say>.</> },
      { art: "undo", tone: ORANGE, title: "Take it back", body: <><Say>scratch that</Say> drops what you just said. <Say>no wait, Monday</Say> fixes the last bit.</> },
      { art: "emoji", tone: GOLD, title: "Spoken emoji", body: <>End a phrase with "emoji": <Say>thumbs up emoji</Say> types 👍.</> },
      { art: "snippets", tone: VIOLET, title: "Voice snippets", body: <>Save text once in <b>Formatting options</b>, then say <Say>my address</Say> and the whole thing is typed.</> },
    ],
  },
  {
    label: "Better results",
    tips: [
      { art: "dictionary", tone: VIOLET, title: "Teach it your words", body: <>Add names and jargon to the <b>Dictionary</b>, plus how they get misheard.</> },
      { art: "formatting", tone: GREEN, title: "Turn on formatting", body: <>In <b>Formatting options</b>, pick what gets fixed before typing.</> },
      { art: "pastecard", tone: ORANGE, title: "Nowhere to type?", body: <>A card pops up with what you said and a <b>Copy</b> button. Don't want it? Turn it off in <b>Settings</b>.</> },
      { art: "miccheck", tone: GREEN, title: "Test your mic", body: <>In <b>Settings → Audio input</b>, <b>Check levels</b> shows a live meter while you talk.</> },
      { art: "music", tone: GOLD, title: "Music pauses for you", body: <>{IS_MAC ? "Spotify and Music pause while you talk, and everything else turns down." : "Other sound is muted while you talk."} It all comes back when you stop.</> },
      { art: "sysaudio", tone: VIOLET, title: "Transcribe what's playing", body: <>Set <b>Listen to</b> to <b>System audio</b> to turn a video, call or voice note into text.</> },
    ],
  },
  {
    label: "Privacy and the app",
    tips: [
      { art: "incognito", tone: VIOLET, title: "Incognito", body: <>Turn it on from the sidebar or the orb menu and nothing is saved to History.</> },
      { art: "quit", tone: GOLD, title: "Closing isn't quitting", body: <>LocalFlow keeps listening when this window is closed. Quit from the orb menu.</> },
      ...(IS_MAC ? [{ art: "lock", tone: ORANGE, title: "Lock your History", body: <>Turn on <b>Lock History</b> and it asks for Touch ID first. Old dictations can also delete themselves.</> }] : []),
      { art: "autodelete", tone: GOLD, title: "Auto-delete history", body: <>Old dictations can delete themselves after 1, 7 or 30 days. Never is the default.</> },
      { art: "nosave", tone: VIOLET, title: "Keep some apps out", body: <>Dictations into apps you pick, like a password manager or bank, are never saved.</> },
      { art: "share", tone: GREEN, title: "Private on calls", body: <><b>Hide from screen sharing</b> keeps the orb and copy card off Zoom, Meet and recordings.</> },
      { art: "theme", tone: VIOLET, title: "Light or dark", body: <>Switch at the bottom of the sidebar.</> },
    ],
  },
];


/** What opens when a tip is clicked: how it works, step by step, and where to go. */
interface How {
  steps: ReactNode[];
  go?: { label: string; to: string };
}

const HOW: Record<string, How> = {
  orbmenu: { steps: [
    <>Right-click the orb (or Control-click) wherever it sits on screen.</>,
    <>Pick <b>Incognito</b> to stop saving, <b>Sounds</b> to mute the taps, <b>Hide</b> to put the orb away, <b>Open</b> for this window, or <b>Quit</b>.</>,
  ] },
  clicktalk: { steps: [
    <>Start a dictation with your shortcut.</>,
    <>When you're done talking, click the orb instead of pressing the shortcut again.</>,
    <>Your words are typed into the app you were in, as usual.</>,
  ] },
  place: { steps: [
    <>Drag the orb and let go near any corner or edge: it snaps to the closest of 8 spots.</>,
    <>Or click the orb while it's idle and pick a spot from the overlay. <K>Esc</K> cancels.</>,
    <>To fine-tune it, use the sliders under <b>Orb position</b> in Settings.</>,
  ], go: { label: "Open Display settings", to: "/settings#display" } },
  notch: { steps: [
    <>Open <b>Settings → Display → Animation</b>.</>,
    <>Pick <b>Notch</b> for an island that grows out of the notch while you talk, or <b>Off</b> to show nothing.</>,
  ], go: { label: "Open Display settings", to: "/settings#display" } },
  holdfn: { steps: [
    <>Make sure <b>Fn quick toggle</b> is on in <b>Shortcuts</b>.</>,
    <>Click into any text box, then hold <K>Fn</K> and talk.</>,
    <>Let go: LocalFlow transcribes and types it where your cursor is.</>,
  ], go: { label: "Open Shortcuts", to: "/shortcuts" } },
  doubletap: { steps: [
    <>Tap <K>Fn</K> twice quickly. The orb stays listening on its own.</>,
    <>Talk as long as you like, with your hands free.</>,
    <>Tap <K>Fn</K> once more to finish and type it.</>,
  ], go: { label: "Open Shortcuts", to: "/shortcuts" } },
  esc: { steps: [
    <>While you're talking, press <K>Esc</K>.</>,
    <>The recording is thrown away and nothing is typed or saved.</>,
  ] },
  shortcuts: { steps: [
    <>Open <b>Shortcuts</b>.</>,
    <>Click a shortcut and press the keys you want, or a mouse button (like the side buttons).</>,
    <>Choose <b>hold</b> (talk while held) or <b>toggle</b> (press to start, press to stop).</>,
  ], go: { label: "Open Shortcuts", to: "/shortcuts" } },
  timer: { steps: [
    <>Start a dictation (double-tap <K>Fn</K> is easiest for long ones) and keep talking.</>,
    <>Every 8 minutes or so, what you've said so far is transcribed in the background, cut at a pause, never mid-word.</>,
    <>When you stop, the last part is added and the whole thing is cleaned up and typed at once.</>,
  ] },
  punct: { steps: [
    <>Say punctuation as a word: <Say>comma</Say>, <Say>period</Say>, <Say>question mark</Say>, <Say>exclamation mark</Say>, <Say>colon</Say>.</>,
    <>Say <Say>new line</Say> to break the line, or <Say>new paragraph</Say> for a blank line.</>,
    <>Needs <b>Spoken punctuation</b> turned on in <b>Formatting options</b>.</>,
  ], go: { label: "Open Formatting options", to: "/llm" } },
  undo: { steps: [
    <>Say <Say>scratch that</Say> to drop everything you said before it.</>,
    <>Correct yourself mid-sentence: <Say>meet on Tuesday, no wait, Monday</Say> types "meet on Monday".</>,
    <>Needs <b>Spoken punctuation</b> (for "scratch that") and <b>Follow my corrections</b> on in <b>Formatting options</b>.</>,
  ], go: { label: "Open Formatting options", to: "/llm" } },
  emoji: { steps: [
    <>Say the emoji's name, then the word "emoji": <Say>heart emoji</Say>, <Say>fire emoji</Say>, <Say>thumbs up emoji</Say>.</>,
    <>It's typed as the emoji itself, right where you said it.</>,
    <>Needs <b>Spoken emoji</b> turned on in <b>Formatting options</b>.</>,
  ], go: { label: "Open Formatting options", to: "/llm" } },
  snippets: { steps: [
    <>Open <b>Formatting options</b> and scroll to <b>Voice snippets</b>.</>,
    <>Type a phrase to say (like <Say>my address</Say>) and the text it should become, then press <b>Add</b>.</>,
    <>Dictate the phrase and the saved text is typed. One-word snippets only work when you say just that word.</>,
  ], go: { label: "Open Formatting options", to: "/llm" } },
  dictionary: { steps: [
    <>Open <b>Formatting options</b> and scroll to <b>Dictionary</b>.</>,
    <>Add the word spelled right (a name, a product, jargon).</>,
    <>Optionally add how it gets misheard, e.g. "buy sunny" for "Bysani". LocalFlow swaps it every time.</>,
  ], go: { label: "Open Dictionary", to: "/llm" } },
  formatting: { steps: [
    <>Open <b>Formatting options</b> and turn formatting on.</>,
    <>Pick what gets fixed: filler words, your corrections, capital letters, spoken punctuation and emoji.</>,
    <>Try a sentence in <b>Try it</b> to see the result before you dictate.</>,
  ], go: { label: "Open Formatting options", to: "/llm" } },
  pastecard: { steps: [
    <>If no text box is selected when you finish, a card appears with your words and a <b>Copy</b> button.</>,
    <>Hover it to keep it open; it closes by itself after 10 seconds.</>,
    <>Don't want it? Turn off <b>Copy card</b> in Settings → Display. Your words still go to History.</>,
  ], go: { label: "Open Display settings", to: "/settings#display" } },
  miccheck: { steps: [
    <>Open <b>Settings → Audio input</b> and click <b>Check levels</b>.</>,
    <>Talk normally and watch the meter: aim for the green zone.</>,
    <>Too quiet? Move closer, or pick a different <b>Microphone</b> right above it.</>,
  ], go: { label: "Open Audio input", to: "/settings#audio" } },
  music: { steps: [
    <>It's on by default: <b>Settings → Audio input → Pause music while dictating</b>.</>,
    <>{IS_MAC ? "Spotify and Music pause while you talk; other sound (like YouTube) is turned down." : "Other sound is muted while you talk."}</>,
    <>Everything comes back the moment you stop. {IS_MAC ? "macOS asks once before LocalFlow can pause Spotify or Music." : ""}</>,
  ], go: { label: "Open Audio input", to: "/settings#audio" } },
  sysaudio: { steps: [
    <>Open <b>Settings → Audio input</b> and set <b>Listen to</b> to <b>System audio</b>.</>,
    <>Play a video, call or voice note, then use your dictation shortcut as usual to start and stop.</>,
    <>What was playing is typed out. {IS_MAC ? "macOS asks once for System Audio Recording permission." : ""} Switch back to <b>Microphone</b> to dictate again.</>,
  ], go: { label: "Open Audio input", to: "/settings#audio" } },
  incognito: { steps: [
    <>Click <b>Incognito mode</b> at the bottom of the sidebar, or pick it from the orb's right-click menu.</>,
    <>Dictation works as usual, but nothing is saved to History.</>,
    <>Turn it off the same way.</>,
  ] },
  lock: { steps: [
    <>Open <b>Settings → Privacy</b> and turn on <b>Lock History</b>.</>,
    <>Opening History now asks for Touch ID or your Mac password. It locks again when the window is hidden.</>,
    <>To delete old dictations automatically, set <b>Auto-delete history</b> to 1, 7 or 30 days.</>,
  ], go: { label: "Open Privacy settings", to: "/settings#privacy" } },
  transparency: { steps: [
    <>Open <b>Settings → Display</b>.</>,
    <>Drag <b>Orb transparency</b> left to make the orb fainter (down to 20%).</>,
    <>Only the orb fades: its menu and messages stay solid so you can read them.</>,
  ], go: { label: "Open Display settings", to: "/settings#display" } },
  fullscreen: { steps: [
    <>Nothing to set up: the orb shows on every desktop and over full-screen apps.</>,
    <>In a full-screen app the Dock and menu bar are hidden, so the orb moves down to the real screen edge, then back when you leave.</>,
  ] },
  autodelete: { steps: [
    <>Open <b>Settings → Privacy</b>.</>,
    <>Set <b>Auto-delete history</b> to <b>After 1 day</b>, <b>7 days</b> or <b>30 days</b>.</>,
    <>Older dictations are deleted right away, then checked every hour. <b>Never</b> keeps everything.</>,
  ], go: { label: "Open Privacy settings", to: "/settings#privacy" } },
  nosave: { steps: [
    <>Open <b>Settings → Privacy → Don't save from these apps</b>.</>,
    <>Type to search for an app and press <K>Enter</K> to add it.</>,
    <>Dictation still works there, but nothing you say in that app goes into History. Click × to remove it.</>,
  ], go: { label: "Open Privacy settings", to: "/settings#privacy" } },
  share: { steps: [
    <>Open <b>Settings → Privacy</b> and turn on <b>Hide from screen sharing</b>.</>,
    <>You still see the orb, notch and copy card. People on Zoom, Meet or watching a recording don't.</>,
    <>Click <b>See how it looks</b> next to the switch for a side-by-side example.</>,
  ], go: { label: "Open Privacy settings", to: "/settings#privacy" } },
  quit: { steps: [
    <>Closing this window keeps LocalFlow running, so your shortcut still works.</>,
    <>To stop it completely, right-click the orb and pick <b>Quit</b>.</>,
  ] },
  theme: { steps: [
    <>Click the sun or moon at the bottom of the sidebar to switch between light and dark.</>,
  ] },
};

/** The "how it works" popup for one tip. */
function TipDialog({ tip, onClose }: { tip: Tip; onClose: () => void }) {
  const navigate = useNavigate();
  const close = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const how = HOW[tip.art];

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => opener?.focus?.();
  }, []);

  return createPortal(
    <div className="confirm-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="confirm-dialog glass-panel tip-dialog tip-card is-seen is-live"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ "--tone": tip.tone, "--i": 0 } as CSSProperties}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
      >
        <button ref={close} type="button" className="tip-dialog-close" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
        <div className="tip-art"><TipArt name={tip.art} /></div>
        <h2 id={titleId}>{tip.title}</h2>
        <p className="tips-body">{tip.body}</p>
        {how && (
          <>
            <p className="tip-dialog-label">How it works</p>
            <ol className="tip-steps">
              {how.steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          </>
        )}
        <div className="confirm-actions">
          {how?.go && (
            <button type="button" className="button" onClick={() => { onClose(); navigate(how.go!.to); }}>
              {how.go.label}
            </button>
          )}
          <button type="button" className="button primary" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A grid of cards: a tinted panel with a small looping line drawing, then the title
 * and one line of text. Cards rise in as they scroll into view, and a drawing only
 * animates while it is on screen.
 */
export default function TipsPage() {
  const pageRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Tip | null>(null);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const root = page.closest(".page-scroll");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          e.target.classList.toggle("is-live", e.isIntersecting);
          if (e.isIntersecting) e.target.classList.add("is-seen");
        }
      },
      { root, threshold: 0.2 },
    );
    page.querySelectorAll(".tip-card, .tips-chapter").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <div className="page tips-page" ref={pageRef}>
      <div className="page-header">
        <div>
          <p className="page-kicker">Get more out of it</p>
          <h2 className="page-title">Tips</h2>
        </div>
      </div>

      {GROUPS.map((g, gi) => (
        <section key={g.label} className="tips-group">
          <header className="tips-chapter">
            <span className="tips-chapter-num">{String(gi + 1).padStart(2, "0")}</span>
            <h3>{g.label}</h3>
          </header>
          <div className="tips-grid">
            {g.tips.map((t, i) => (
              <article key={t.title} className="tip-card" style={{ "--tone": t.tone, "--i": i } as CSSProperties}>
                <button type="button" className="tip-open" onClick={() => setOpen(t)} aria-label={`${t.title}: how it works`}>
                  <div className="tip-art"><TipArt name={t.art} /></div>
                  <h4 className="tips-title">{t.title}</h4>
                  <p className="tips-body">{t.body}</p>
                  <span className="tip-more">How it works →</span>
                </button>
              </article>
            ))}
          </div>
        </section>
      ))}
      {open && <TipDialog tip={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
