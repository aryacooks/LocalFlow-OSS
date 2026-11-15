import { useEffect, useRef } from "react";
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
      { art: "timer", tone: GOLD, title: "10 minutes per recording", body: <>Talk past that and only the last 10 minutes are kept.</> },
    ],
  },
  {
    label: "Say it, and it happens",
    tips: [
      { art: "punct", tone: GREEN, title: "Punctuation and lines", body: <>Say <Say>comma</Say>, <Say>question mark</Say>, <Say>new line</Say> or <Say>new paragraph</Say>.</> },
      { art: "undo", tone: ORANGE, title: "Take it back", body: <><Say>scratch that</Say> drops what you just said. <Say>no wait, Monday</Say> fixes the last bit.</> },
      { art: "emoji", tone: GOLD, title: "Spoken emoji", body: <>End a phrase with "emoji": <Say>thumbs up emoji</Say> types 👍.</> },
    ],
  },
  {
    label: "Better results",
    tips: [
      { art: "dictionary", tone: VIOLET, title: "Teach it your words", body: <>Add names and jargon to the <b>Dictionary</b>, plus how they get misheard.</> },
      { art: "formatting", tone: GREEN, title: "Turn on formatting", body: <>In <b>Formatting options</b>, pick what gets fixed before typing.</> },
      { art: "pastecard", tone: ORANGE, title: "Nowhere to type?", body: <>A card pops up with what you said and a <b>Copy</b> button, so nothing is lost.</> },
    ],
  },
  {
    label: "Privacy and the app",
    tips: [
      { art: "incognito", tone: VIOLET, title: "Incognito", body: <>Turn it on from the sidebar or the orb menu and nothing is saved to History.</> },
      { art: "quit", tone: GOLD, title: "Closing isn't quitting", body: <>LocalFlow keeps listening when this window is closed. Quit from the orb menu.</> },
      { art: "theme", tone: GREEN, title: "Make it yours", body: <>Switch <b>Theme</b> and light or dark at the bottom of the sidebar.</> },
    ],
  },
];

/**
 * A grid of cards: a tinted panel with a small looping line drawing, then the title
 * and one line of text. Cards rise in as they scroll into view, and a drawing only
 * animates while it is on screen.
 */
export default function TipsPage() {
  const pageRef = useRef<HTMLDivElement>(null);

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
                <div className="tip-art"><TipArt name={t.art} /></div>
                <h4 className="tips-title">{t.title}</h4>
                <p className="tips-body">{t.body}</p>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
