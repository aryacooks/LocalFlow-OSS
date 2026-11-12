import type { CSSProperties, ReactNode } from "react";
import {
  BookOpen,
  Copy,
  Ghost,
  Hand,
  Keyboard,
  Mic,
  MousePointerClick,
  Move,
  Palette,
  Power,
  Smile,
  Sparkles,
  Timer,
  Type,
  Undo2,
} from "lucide-react";

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

interface Tip {
  icon: ReactNode;
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

const GROUPS: Group[] = [
  {
    label: "The orb",
    tips: [
      {
        icon: <MousePointerClick size={16} />,
        tone: "#e0662a",
        title: "Right-click the orb",
        body: <>Opens its menu: turn <b>Incognito</b> or <b>Sounds</b> on and off, <b>Hide</b> the orb, <b>Open</b> the app or <b>Quit</b> it.</>,
      },
      {
        icon: <Mic size={16} />,
        tone: "#2e9e5b",
        title: "Click it while talking",
        body: <>Finishes the dictation and types it, the same as letting go of your shortcut.</>,
      },
      {
        icon: <Move size={16} />,
        tone: "#c9891a",
        title: "Drag it, or click to place it",
        body: <>Drag the orb anywhere and it snaps to the nearest of 8 spots. Or click it when idle and pick a spot. <K>Esc</K> cancels.</>,
      },
      ...(IS_MAC
        ? [{
            icon: <Sparkles size={16} />,
            tone: "#6d5bd0",
            title: "Prefer the notch?",
            body: <>In <b>Settings</b>, switch the orb to an island that grows out of the notch, or hide it entirely.</>,
          }]
        : []),
    ],
  },
  {
    label: "Talking",
    tips: [
      ...(IS_MAC
        ? [
            {
              icon: <Hand size={16} />,
              tone: "#2e9e5b",
              title: "Hold Fn to talk",
              body: <>Hold <K>Fn</K>, speak, let go. Your words are typed wherever your cursor is.</>,
            },
            {
              icon: <Keyboard size={16} />,
              tone: "#e0662a",
              title: "Double-tap Fn for hands-free",
              body: <>Tap <K>Fn</K> twice and keep talking as long as you like. Tap <K>Fn</K> once more to stop.</>,
            },
          ]
        : [
            {
              icon: <Keyboard size={16} />,
              tone: "#e0662a",
              title: "Esc cancels",
              body: <>Changed your mind mid-sentence? Press <K>Esc</K> and nothing gets typed.</>,
            },
          ]),
      {
        icon: <MousePointerClick size={16} />,
        tone: "#6d5bd0",
        title: "Your own shortcuts",
        body: <>On <b>Shortcuts</b>, pick any key combo to toggle or hold, including the side buttons on your mouse.</>,
      },
      {
        icon: <Timer size={16} />,
        tone: "#c9891a",
        title: "10 minutes per recording",
        body: <>Keep talking past that and only the last 10 minutes are kept. Longer talks take a little longer to type.</>,
      },
    ],
  },
  {
    label: "Say it, and it happens",
    tips: [
      {
        icon: <Type size={16} />,
        tone: "#2e9e5b",
        title: "Punctuation and lines",
        body: <><Say>new line</Say>, <Say>new paragraph</Say>, <Say>comma</Say>, <Say>period</Say>, <Say>question mark</Say>, <Say>exclamation mark</Say>, <Say>colon</Say>, <Say>semicolon</Say>.</>,
      },
      {
        icon: <Undo2 size={16} />,
        tone: "#e0662a",
        title: "Take it back",
        body: <>Say <Say>scratch that</Say> or <Say>delete that</Say> to drop what you just said. With cleanup on, <Say>no wait, Monday</Say> fixes the last bit too.</>,
      },
      {
        icon: <Smile size={16} />,
        tone: "#c9891a",
        title: "Spoken emoji",
        body: <>End a phrase with "emoji": <Say>laughing emoji</Say> types 😂, <Say>thumbs up emoji</Say> types 👍.</>,
      },
    ],
  },
  {
    label: "Better results",
    tips: [
      {
        icon: <BookOpen size={16} />,
        tone: "#6d5bd0",
        title: "Teach it your words",
        body: <>Add names and jargon to the <b>Dictionary</b> in <b>Formatting options</b>, plus how they get misheard, and they're spelled right every time.</>,
      },
      {
        icon: <Sparkles size={16} />,
        tone: "#2e9e5b",
        title: "Turn on cleanup",
        body: <>In <b>Formatting options</b>, a small on-device AI removes "um"s, fixes repeats and matches the app you're writing in.</>,
      },
      {
        icon: <Copy size={16} />,
        tone: "#e0662a",
        title: "Nowhere to type?",
        body: <>If no text box was selected, a card pops up with what you said and a <b>Copy</b> button, so nothing is lost.</>,
      },
    ],
  },
  {
    label: "Privacy and the app",
    tips: [
      {
        icon: <Ghost size={16} />,
        tone: "#6d5bd0",
        title: "Incognito",
        body: <>Turn it on from the sidebar or the orb menu and nothing you say is saved to History.</>,
      },
      {
        icon: <Power size={16} />,
        tone: "#c9891a",
        title: "Closing isn't quitting",
        body: <>LocalFlow keeps listening for your shortcut when this window is closed. Quit from the orb menu or <b>Quit App</b>.</>,
      },
      {
        icon: <Palette size={16} />,
        tone: "#2e9e5b",
        title: "Make it yours",
        body: <>Switch <b>Theme</b> between Normal and Oil, and light or dark, at the bottom of the sidebar.</>,
      },
    ],
  },
];

export default function TipsPage() {
  return (
    <div className="page tips-page">
      <div className="page-header">
        <div>
          <p className="page-kicker">Get more out of it</p>
          <h2 className="page-title">Tips</h2>
        </div>
      </div>

      {GROUPS.map((g) => (
        <section key={g.label} className="tips-group">
          <div className="section-label">{g.label}</div>
          <div className="tips-grid">
            {g.tips.map((t) => (
              <article key={t.title} className="glass-panel tips-card">
                <span className="tips-icon" style={{ "--tone": t.tone } as CSSProperties}>{t.icon}</span>
                <div>
                  <h3 className="tips-title">{t.title}</h3>
                  <p className="tips-body">{t.body}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
