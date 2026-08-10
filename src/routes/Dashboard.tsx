import { Fragment, useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Mic, Timer, TrendingUp, Cpu, Zap, Activity, Scissors, Hourglass } from "lucide-react";
import InfoCircleIcon from "../components/ui/info-circle-icon";
import { DashboardStats, getDashboardStats, getSystemStats, SystemStats, getSetting, setSetting, WordsPerDay } from "../lib/ipc";
import { keyLabel } from "../lib/utils";
import { useAppStore } from "../lib/store";

const CHART_COLORS = ["#007aff", "#34c759", "#5ac8fa", "#ff9500", "#af52de", "#8e8e93"];

const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);

// Typing at 60 WPM is the baseline every "time saved" figure is measured against.
const TYPING_WPM = 60;

// ── Time buckets ───────────────────────────────────────────────────────────
// The backend hands back one row per local day (three years of them). Everything
// the dashboard shows by day / week / month / year is rolled up from that single
// series here, so the totals and the chart can never disagree.

type Period = "today" | "week" | "month" | "year";
type Grain = "daily" | "weekly" | "monthly" | "yearly";

const PERIODS: { id: Period; label: string; note: string }[] = [
  { id: "today", label: "Today", note: "since midnight" },
  { id: "week", label: "Week", note: "since Monday" },
  { id: "month", label: "Month", note: "this calendar month" },
  { id: "year", label: "Year", note: "this calendar year" },
];

const GRAINS: { id: Grain; label: string; note: string }[] = [
  { id: "daily", label: "Daily", note: "Last 14 days" },
  { id: "weekly", label: "Weekly", note: "Last 12 weeks" },
  { id: "monthly", label: "Monthly", note: "Last 12 months" },
  { id: "yearly", label: "Yearly", note: "Last 5 years" },
];

/** Local YYYY-MM-DD, matching the keys the backend groups by. */
function dateKey(d: Date): string {
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

function parseKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Monday of the week containing `d`. */
function startOfWeek(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // getDay() is 0 for Sunday, which is the *end* of the week here.
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
}

/** Inclusive first day of the calendar period containing today. */
function periodStart(period: Period, today: Date): Date {
  switch (period) {
    case "today":
      return new Date(today.getFullYear(), today.getMonth(), today.getDate());
    case "week":
      return startOfWeek(today);
    case "month":
      return new Date(today.getFullYear(), today.getMonth(), 1);
    case "year":
      return new Date(today.getFullYear(), 0, 1);
  }
}

/** Words + dictations recorded since the start of the given calendar period. */
function totalsFor(days: WordsPerDay[], period: Period, today = new Date()) {
  const from = dateKey(periodStart(period, today));
  const to = dateKey(today);
  let words = 0;
  let dictations = 0;
  for (const day of days) {
    if (day.date >= from && day.date <= to) {
      words += day.words;
      dictations += day.dictations ?? 0;
    }
  }
  return { words, dictations, minutesSaved: words / TYPING_WPM };
}

type Bucket = { label: string; words: number; dictations: number };

/** Roll the daily series into chart buckets, keeping empty periods so gaps show. */
function bucketSeries(days: WordsPerDay[], grain: Grain, today = new Date()): Bucket[] {
  const byKey = new Map(days.map((d) => [d.date, d]));
  const add = (bucket: Bucket, key: string) => {
    const day = byKey.get(key);
    if (day) {
      bucket.words += day.words;
      bucket.dictations += day.dictations ?? 0;
    }
  };
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const out: Bucket[] = [];

  if (grain === "daily") {
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const bucket: Bucket = { label: `${d.getDate()} ${months[d.getMonth()]}`, words: 0, dictations: 0 };
      add(bucket, dateKey(d));
      out.push(bucket);
    }
  } else if (grain === "weekly") {
    const thisWeek = startOfWeek(today);
    for (let i = 11; i >= 0; i--) {
      const start = new Date(thisWeek);
      start.setDate(start.getDate() - i * 7);
      const bucket: Bucket = { label: `${start.getDate()} ${months[start.getMonth()]}`, words: 0, dictations: 0 };
      for (let d = 0; d < 7; d++) {
        const day = new Date(start);
        day.setDate(start.getDate() + d);
        add(bucket, dateKey(day));
      }
      out.push(bucket);
    }
  } else if (grain === "monthly") {
    for (let i = 11; i >= 0; i--) {
      const start = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const bucket: Bucket = { label: months[start.getMonth()], words: 0, dictations: 0 };
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
      for (const day of days) {
        const d = parseKey(day.date);
        if (d >= start && d < end) {
          bucket.words += day.words;
          bucket.dictations += day.dictations ?? 0;
        }
      }
      out.push(bucket);
    }
  } else {
    for (let i = 4; i >= 0; i--) {
      const year = today.getFullYear() - i;
      const bucket: Bucket = { label: String(year), words: 0, dictations: 0 };
      for (const day of days) {
        if (day.date.startsWith(`${year}-`)) {
          bucket.words += day.words;
          bucket.dictations += day.dictations ?? 0;
        }
      }
      out.push(bucket);
    }
  }

  return out;
}

/** "0 min" / "45 min" / "3h 20m" — the one place minutes get rendered. */
function formatMinutes(m: number): string {
  if (m <= 0) return "0 min";
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60);
  const min = Math.round(m % 60);
  return min === 0 ? `${h}h` : `${h}h ${min}m`;
}

/** The small pill row used to switch period / grain. */
function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="segmented" role="tablist" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          role="tab"
          aria-selected={value === opt.id}
          className={`segmented-option ${value === opt.id ? "is-active" : ""}`}
          onClick={() => onChange(opt.id)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// "Local only" status, with no pill chrome — just a status dot and text that types
// itself out word-by-word, holds, clears, and loops smoothly (typewriter effect).
function LocalOnlyTyping() {
  const FULL = "Local only";
  const [count, setCount] = useState(0);
  const [phase, setPhase] = useState<"typing" | "holding" | "clearing">("typing");

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    if (phase === "typing") {
      if (count < FULL.length) {
        t = setTimeout(() => setCount((c) => c + 1), 105);
      } else {
        t = setTimeout(() => setPhase("holding"), 1600);
      }
    } else if (phase === "holding") {
      t = setTimeout(() => setPhase("clearing"), 200);
    } else {
      if (count > 0) {
        t = setTimeout(() => setCount((c) => c - 1), 55);
      } else {
        t = setTimeout(() => setPhase("typing"), 500);
      }
    }
    return () => clearTimeout(t);
  }, [count, phase]);

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        fontWeight: 600,
        color: "var(--success)",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--success)", flexShrink: 0 }} />
      {/* Reserve the full width so neighbours don't shift as the text types/clears. */}
      <span style={{ position: "relative", display: "inline-block" }}>
        <span style={{ visibility: "hidden", whiteSpace: "pre" }}>{FULL}</span>
        <span style={{ position: "absolute", left: 0, top: 0, whiteSpace: "pre" }}>
          {FULL.slice(0, count)}
          <span className="local-only-caret">|</span>
        </span>
      </span>
      <style>{`
        .local-only-caret {
          margin-left: 1px;
          font-weight: 400;
          animation: localOnlyBlink 1s steps(1) infinite;
        }
        @keyframes localOnlyBlink { 0%, 50% { opacity: 1; } 50.01%, 100% { opacity: 0; } }
      `}</style>
    </span>
  );
}

function WpmGauge({ wpm }: { wpm: number }) {
  let pct = 50;
  let text = "Average WPM";
  let badge = "Top 50%";

  if (wpm >= 120) {
    pct = 99.5;
    text = "Elite Dictation Speed";
    badge = "Top 0.5%";
  } else if (wpm >= 110) {
    pct = 99;
    text = "Superfast Writer";
    badge = "Top 1%";
  } else if (wpm >= 100) {
    pct = 98;
    text = "Professional Typist";
    badge = "Top 2%";
  } else if (wpm >= 90) {
    pct = 95;
    text = "Fast Dictation";
    badge = "Top 5%";
  } else if (wpm >= 80) {
    pct = 90;
    text = "Above Average";
    badge = "Top 10%";
  } else if (wpm >= 70) {
    pct = 80;
    text = "Fluent Writer";
    badge = "Top 20%";
  } else if (wpm >= 60) {
    pct = 70;
    text = "Standard Speed";
    badge = "Top 30%";
  } else if (wpm >= 50) {
    pct = 60;
    text = "Regular Typist";
    badge = "Top 40%";
  } else if (wpm >= 40) {
    pct = 50;
    text = "Average Typist";
    badge = "Top 50%";
  } else if (wpm >= 30) {
    pct = 30;
    text = "Leisurely Pace";
    badge = "Top 70%";
  } else if (wpm > 0) {
    pct = 15;
    text = "Starting Out";
    badge = "Top 85%";
  } else {
    pct = 0;
    text = "No speed data";
    badge = "New";
  }

  return (
    <div className="glass-panel dashboard-wpm-panel" style={{ minHeight: 185 }}>
      <div className="dashboard-wpm-header">
        <span className="stat-label">Words Per Minute</span>
      </div>
      <span className="stat-value dashboard-wpm-value">
        {wpm > 0 ? Math.round(wpm) : "--"}
      </span>
      <div
        className="dashboard-wpm-track"
        role="progressbar"
        aria-label="Writing speed percentile"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <span className="dashboard-wpm-progress" style={{ width: `${pct}%` }} />
        <span className="dashboard-wpm-marker" style={{ left: `${pct}%` }} />
      </div>
      <div className="dashboard-wpm-footer">
        <span className="dashboard-wpm-description">{text}</span>
        <span className="dashboard-wpm-rank">{badge}</span>
      </div>
    </div>
  );
}

function getStreakGridData(wordsPerDay: { date: string; words: number }[]) {
  const today = new Date();
  const currentDayOfWeek = today.getDay(); // 0 is Sunday, 6 is Saturday
  
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - currentDayOfWeek - 11 * 7); // Go back 11 weeks + current week's Sunday
  
  const wordMap = new Map<string, number>();
  wordsPerDay.forEach(d => {
    wordMap.set(d.date, d.words);
  });
  
  const cols = [];
  for (let week = 0; week < 12; week++) {
    const colDays = [];
    for (let d = 0; d < 7; d++) {
      const dayDate = new Date(startDate);
      dayDate.setDate(startDate.getDate() + week * 7 + d);
      
      const dateStr = dayDate.getFullYear() + "-" + 
                      String(dayDate.getMonth() + 1).padStart(2, '0') + "-" + 
                      String(dayDate.getDate()).padStart(2, '0');
                      
      const words = wordMap.get(dateStr) ?? 0;
      
      colDays.push({
        date: dayDate,
        dateStr,
        words,
        isFuture: dayDate > today,
        isToday: dateStr === today.getFullYear() + "-" + 
                           String(today.getMonth() + 1).padStart(2, '0') + "-" + 
                           String(today.getDate()).padStart(2, '0')
      });
    }
    cols.push(colDays);
  }
  
  return cols;
}

function StreakCalendar({ wordsPerDay, currentStreak, longestStreak }: { wordsPerDay: any[], currentStreak: number, longestStreak: number }) {
  const cols = getStreakGridData(wordsPerDay || []);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  
  const columnMonths: string[] = [];
  cols.forEach((col, index) => {
    const firstDay = col[0].date;
    const monthName = months[firstDay.getMonth()];
    if (index === 0 || months[cols[index - 1][0].date.getMonth()] !== monthName) {
      columnMonths.push(monthName);
    } else {
      columnMonths.push("");
    }
  });

  const daysOfWeek = ["S", "M", "T", "W", "T", "F", "S"];

  return (
    <div className="glass-panel dashboard-streak-panel" style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 185 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
        <span className="row-title" style={{ fontSize: 13, fontWeight: 600, color: "var(--label)" }}>Activity Streak</span>
        <span className="stat-footnote" style={{ fontSize: 11 }}>
          Current: <strong style={{ color: "var(--label)" }}>{currentStreak}d</strong> | Max: <strong>{longestStreak}d</strong>
        </span>
      </div>

      <div className="streak-grid">
        {/* top-left spacer, then a month label per week column */}
        <div className="streak-corner" />
        {columnMonths.map((m, idx) => (
          <div key={`m${idx}`} className="streak-month">{m}</div>
        ))}

        {/* one row per weekday: day label + a cell per week */}
        {[0, 1, 2, 3, 4, 5, 6].map((rowIdx) => (
          <Fragment key={rowIdx}>
            <div className="streak-daylabel">{daysOfWeek[rowIdx]}</div>
            {cols.map((col, colIdx) => {
              const day = col[rowIdx];
              let bgColor = "transparent";
              let border = "1px solid var(--separator-soft)";

              if (day.isFuture) {
                border = "none";
              } else if (day.words > 0) {
                const intensity = Math.min(28 + Math.round((day.words / 650) * 62), 90);
                bgColor = `color-mix(in srgb, var(--success) ${intensity}%, var(--panel))`;
                border = "none";
              }

              if (day.isToday) {
                border = "1px solid var(--label)";
              }

              const dateStr = day.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
              const tooltipText = day.words > 0
                ? `${day.words} words on ${dateStr}`
                : `No words on ${dateStr}`;

              return (
                <div
                  key={colIdx}
                  className="streak-cell"
                  data-tooltip={tooltipText}
                  style={{ backgroundColor: bgColor, border }}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
      
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 4, fontSize: 8, color: "var(--secondary)", marginTop: 2 }}>
        <span>Less</span>
        <div style={{ width: 7, height: 7, borderRadius: 1, border: "1px solid var(--separator-soft)" }} />
        <div style={{ width: 7, height: 7, borderRadius: 1, backgroundColor: "color-mix(in srgb, var(--success) 35%, var(--panel))" }} />
        <div style={{ width: 7, height: 7, borderRadius: 1, backgroundColor: "color-mix(in srgb, var(--success) 60%, var(--panel))" }} />
        <div style={{ width: 7, height: 7, borderRadius: 1, backgroundColor: "color-mix(in srgb, var(--success) 88%, var(--panel))" }} />
        <span>More</span>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const showBanner = true;
  const [trackApps, setTrackApps] = useState(true);
  const [sysStats, setSysStats] = useState<SystemStats | null>(null);
  const [shortcutToggle, setShortcutToggle] = useState("Ctrl+Alt");
  const [keybindKeyboardName, setKeybindKeyboardName] = useState("Ctrl+Q");
  const [keybindMouseToggle, setKeybindMouseToggle] = useState("none");
  const [keybindMouseInstant, setKeybindMouseInstant] = useState("none");
  const [period, setPeriod] = useState<Period>("today");
  const [grain, setGrain] = useState<Grain>("daily");
  const { isRecording, isProcessing, lastTranscript, startRecording, stopRecording } = useAppStore();

  useEffect(() => {
    // Load app tracking preference and trigger keybind settings
    getSetting("track_apps").then((val) => {
      setTrackApps(val !== "false");
    });
    getSetting("shortcut_toggle").then((val) => {
      if (val) setShortcutToggle(val);
    });
    getSetting("keybind_keyboard_name").then((val) => {
      if (val) setKeybindKeyboardName(val);
    });
    getSetting("keybind_mouse_toggle").then((val) => {
      if (val) setKeybindMouseToggle(val);
    });
    getSetting("keybind_mouse_instant").then((val) => {
      if (val) setKeybindMouseInstant(val);
    });
  }, []);

  // Friendly label for a stored mouse-button value, or null when unset ("none").
  const mouseLabel = (v: string): string | null => {
    switch (v) {
      case "middle": return "Middle click";
      case "right": return "Right click";
      case "button4": case "back": return "Mouse 4";
      case "button5": case "forward": return "Mouse 5";
      default: return null;
    }
  };

  useEffect(() => {
    getDashboardStats()
      .then(setStats)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [lastTranscript]);

  // Telemetry Poll
  useEffect(() => {
    const fetchSysStats = async () => {
      try {
        const data = await getSystemStats();
        setSysStats(data);
      } catch (e) {
        console.error(e);
      }
    };
    fetchSysStats();
    const timer = setInterval(fetchSysStats, 1500);
    return () => clearInterval(timer);
  }, []);

  const handleToggleTrackApps = async (checked: boolean) => {
    setTrackApps(checked);
    await setSetting("track_apps", checked ? "true" : "false");
    // Reload dashboard to update graph representation
    const freshStats = await getDashboardStats();
    setStats(freshStats);
  };

  const displayStats = stats;
  const displayTranscript = lastTranscript?.cleaned || null;
  const wordsPerDay = displayStats?.words_per_day ?? [];

  // Both panels read from the same daily series, so the headline number and the
  // chart can never tell different stories.
  const periodTotals = totalsFor(wordsPerDay, period);
  const periodMeta = PERIODS.find((p) => p.id === period)!;
  const chartData = bucketSeries(wordsPerDay, grain);
  const grainMeta = GRAINS.find((g) => g.id === grain)!;
  const hasChartData = chartData.some((b) => b.words > 0);

  if (loading) {
    return (
      <div className="page" style={{ display: "grid", placeItems: "center", height: "100%", opacity: 0.8 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--secondary)" }}>Loading voice workspace...</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`page dashboard-page ${displayTranscript ? "has-last-transcript" : ""}`} style={{ paddingBottom: 15 }}>
      {/* Dynamic Toggle CSS Style Block */}
      <style>{`
        .live-pulse {
          display: inline-block;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          margin-right: 6px;
        }
        .pulse-idle {
          background-color: var(--tertiary);
        }
        .pulse-recording {
          background-color: var(--danger);
          animation: pulse 1s infinite alternate;
        }
        .pulse-transcribing {
          background-color: var(--accent);
          animation: pulse 0.5s infinite alternate;
        }
        @keyframes pulse {
          from { opacity: 0.4; transform: scale(0.9); }
          to { opacity: 1; transform: scale(1.1); }
        }
      `}</style>

      {showBanner && (
        <div className="banner-card dashboard-banner" style={{ backgroundImage: "url('/red extra.png')" }}>
          <div className="banner-content">
            <h2 className="banner-title">Writes the way <em>you</em> think.</h2>
            <p className="banner-desc">
              Just talk, and your words come out clean and ready to use. LocalFlow clears the "um"s and "uh"s, fixes the bits you say twice, and matches the tone of whatever app you're writing in.
            </p>
            <div className="banner-actions">
              <span className="banner-tag">More accurate than Whisper</span>
              <span className="banner-tag">Works fully offline</span>
              <span className="banner-tag">We never track you</span>
            </div>
          </div>
        </div>
      )}

      <div className="page-header dashboard-header">
        <div>
          <p className="page-kicker">Workspace Overview</p>
          <h2 className="page-title">Your dictation dashboard</h2>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 10 }}>
            {[
              { label: "Toggle", keys: shortcutToggle.split("+") },
              { label: "Instant", keys: keybindKeyboardName.split("+") },
              ...(mouseLabel(keybindMouseToggle) ? [{ label: "Mouse", keys: [mouseLabel(keybindMouseToggle)!] }] : []),
              ...(mouseLabel(keybindMouseInstant) ? [{ label: "Mouse hold", keys: [mouseLabel(keybindMouseInstant)!] }] : []),
            ].map(({ label, keys }) => (
              <span
                key={label}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "3px 8px 3px 11px",
                  background: "var(--control)",
                  border: "1px solid var(--separator-soft)",
                  borderRadius: 999,
                  fontSize: 11,
                  fontWeight: 500,
                  color: "var(--secondary)",
                }}
              >
                {label}
                <span style={{ display: "inline-flex", gap: 3 }}>
                  {keys.map((key, idx) => (
                    <span key={idx} className="keycap" style={{ fontSize: 10, minHeight: 17, padding: "0 6px", textTransform: "none" }}>{keyLabel(key)}</span>
                  ))}
                </span>
              </span>
            ))}
            <LocalOnlyTyping />
          </div>
        </div>
        <button
          className={`button ${isRecording ? "danger" : "primary"}`}
          onClick={isRecording ? stopRecording : startRecording}
          disabled={isProcessing}
          style={{ transition: "all 0.2s" }}
        >
          <Mic size={14} />
          {isProcessing ? "Processing..." : isRecording ? "Stop" : "Test dictation"}
        </button>
      </div>

      {displayTranscript && (
        <section className="glass-panel dashboard-last-transcript" style={{ marginBottom: 12 }}>
          <div className="section-label">Last transcription</div>
          <p style={{ margin: 0, color: "var(--label)", fontSize: 14, lineHeight: "20px", fontWeight: 500 }}>
            {displayTranscript}
          </p>
        </section>
      )}

      <div className="glass-panel dashboard-background-note" style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 12 }}>
        <span style={{ marginTop: 2, flexShrink: 0, display: "inline-flex" }}>
          <InfoCircleIcon size={16} color="var(--accent)" loop />
        </span>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--label)" }}>Keeps working in the background</span>
          {IS_MAC ? (
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: "17px", color: "var(--secondary)" }}>
              You don't need to keep this window open. Dictation still works after you close it. Closing the window just hides it; the app keeps running, and you can reopen it anytime by clicking the LocalFlow icon in the Dock.
              To quit completely, right-click the floating mic icon and choose <strong style={{ color: "var(--danger)" }}>Quit App</strong>.
            </p>
          ) : (
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: "17px", color: "var(--secondary)" }}>
              You don't need to keep this window open. Dictation still works after you close it. Closing the window keeps the app running in the background.
              To quit completely, right-click the floating mic icon and click <strong style={{ color: "var(--danger)" }}>Quit App</strong>.
            </p>
          )}
        </div>
      </div>

      {/* Bento Grid */}
      <div className="grid cols-3 dashboard-primary-grid" style={{ marginBottom: 12, gap: 12 }}>
        {/* WPM percentiles */}
        <WpmGauge wpm={displayStats?.avg_wpm_7d ?? 0} />

        {/* Streak calendar */}
        <StreakCalendar
          wordsPerDay={displayStats?.words_per_day ?? []}
          currentStreak={displayStats?.streak_days ?? 0}
          longestStreak={displayStats?.longest_streak ?? 0}
        />

        {/* Core numbers */}
        <div className="glass-panel dashboard-core-panel" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: 185 }}>
          <div>
            <div className="dashboard-core-head">
              <span className="stat-label">Words</span>
              <SegmentedControl
                ariaLabel="Time period"
                options={PERIODS}
                value={period}
                onChange={setPeriod}
              />
            </div>
            <div className="stat-value" style={{ fontSize: 32, fontWeight: 700, margin: "2px 0 10px 0" }}>
              {periodTotals.words.toLocaleString()}
            </div>
          </div>
          <div style={{ borderTop: "1px solid var(--separator-soft)", paddingTop: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <Timer size={14} color="var(--accent)" />
              <span className="stat-label" style={{ fontSize: 11 }}>
                Time saved {periodMeta.label.toLowerCase() === "today" ? "today" : `this ${periodMeta.label.toLowerCase()}`}
              </span>
            </div>
            <div className="stat-value accent" style={{ fontSize: 26, fontWeight: 700, color: "var(--accent)" }}>
              {formatMinutes(periodTotals.minutesSaved)}
            </div>
            <span className="stat-footnote" style={{ fontSize: 10, display: "block", marginTop: 2 }}>
              {periodTotals.dictations.toLocaleString()} dictations {periodMeta.note} · versus typing at {TYPING_WPM} wpm.
            </span>
          </div>
        </div>
      </div>

      <div className="grid cols-2 dashboard-secondary-grid" style={{ marginBottom: 12, gap: 12 }}>
        {/* Total lifetime words dictated & chart */}
        <div className="glass-panel dashboard-lifetime-panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Lifetime totals: words dictated, and the time that bought back. */}
          <div className="dashboard-lifetime-totals">
            <div>
              <div className="stat-label">Total Lifetime Dictations</div>
              <div className="stat-value" style={{ fontSize: 28, fontWeight: 700 }}>
                {(displayStats?.total_words ?? 0).toLocaleString()} <span style={{ fontSize: 14, fontWeight: 500, color: "var(--secondary)" }}>words</span>
              </div>
              <span className="stat-footnote" style={{ fontSize: 10 }}>
                across {(displayStats?.total_dictations ?? 0).toLocaleString()} dictations
              </span>
            </div>
            <div className="dashboard-lifetime-saved">
              <div className="stat-label" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <Timer size={12} color="var(--accent)" /> Total time saved
              </div>
              <div className="stat-value" style={{ fontSize: 28, fontWeight: 700, color: "var(--accent)" }}>
                {formatMinutes(displayStats?.time_saved_minutes ?? 0)}
              </div>
              <span className="stat-footnote" style={{ fontSize: 10 }}>
                versus typing at {TYPING_WPM} wpm
              </span>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 130 }}>
            <div className="dashboard-chart-head">
              <span className="section-label" style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, margin: 0 }}>
                <TrendingUp size={12} /> {grainMeta.note}
              </span>
              <SegmentedControl
                ariaLabel="Chart grouping"
                options={GRAINS}
                value={grain}
                onChange={setGrain}
              />
            </div>
            <div style={{ flex: 1, minHeight: 100, width: "100%" }}>
              {hasChartData ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 9, fill: "var(--secondary)" }}
                      axisLine={false}
                      tickLine={false}
                      interval="preserveStartEnd"
                      minTickGap={12}
                    />
                    <YAxis type="number" hide domain={[0, "dataMax + 40"]} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "var(--panel-solid)",
                        borderColor: "var(--separator)",
                        borderRadius: 6,
                        fontSize: 11,
                        color: "var(--label)",
                      }}
                      formatter={(value, name) => {
                        const n = Number(value) || 0;
                        return name === "Words"
                          ? [`${n.toLocaleString()} words · ${formatMinutes(n / TYPING_WPM)} saved`, "Words"]
                          : [n.toLocaleString(), String(name)];
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="words"
                      name="Words"
                      stroke="var(--accent)"
                      strokeWidth={2}
                      dot={{ r: 2, fill: "var(--accent)", strokeWidth: 0 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="dictations"
                      name="Dictations"
                      stroke="var(--success)"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ height: "100%", display: "grid", placeItems: "center", fontSize: 11, color: "var(--tertiary)" }}>
                  No dictations in this range yet
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Top apps usage & toggles */}
        <div className="glass-panel dashboard-targets-panel" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 8 }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span className="section-label">Top Dictation Targets</span>
              <button
                type="button"
                className={`switch ${trackApps ? "on" : ""}`}
                role="switch"
                aria-checked={trackApps}
                aria-label="Toggle active window tracking"
                title="Toggle active window tracking"
                onClick={() => handleToggleTrackApps(!trackApps)}
              >
                <span />
              </button>
            </div>
            
            <div style={{ height: 100, width: "100%" }}>
              {!trackApps ? (
                <div style={{ height: "100%", display: "grid", placeItems: "center", textAlign: "center", padding: 10 }}>
                  <div>
                    <span style={{ fontSize: 11, color: "var(--secondary)", fontWeight: 500 }}>App Tracking Disabled</span>
                    <span style={{ fontSize: 9, color: "var(--tertiary)", display: "block", marginTop: 2 }}>
                      Future dictation statistics will not store foreground application logs.
                    </span>
                  </div>
                </div>
              ) : displayStats && displayStats.top_apps && displayStats.top_apps.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={displayStats.top_apps.slice(0, 5)} layout="vertical" barSize={10}>
                    <XAxis type="number" hide />
                    <YAxis
                      type="category"
                      dataKey="app_name"
                      tick={{ fontSize: 10, fill: "var(--secondary)" }}
                      axisLine={false}
                      tickLine={false}
                      interval={0}
                      width={90}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "var(--panel-solid)",
                        borderColor: "var(--separator)",
                        borderRadius: 6,
                        fontSize: 10,
                        color: "var(--label)",
                      }}
                    />
                    <Bar dataKey="word_count" radius={[0, 3, 3, 0]}>
                      {displayStats.top_apps.slice(0, 5).map((_, index) => (
                        <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ height: "100%", display: "grid", placeItems: "center", fontSize: 11, color: "var(--tertiary)" }}>
                  No app logs recorded yet
                </div>
              )}
            </div>
          </div>
          <div style={{ fontSize: 9, color: "var(--tertiary)", borderTop: "1px solid var(--separator-soft)", paddingTop: 4 }}>
            App information is logged fully locally and only while dictating.
          </div>
        </div>
      </div>

      {/* Analytics Panel */}
      <section className="glass-panel dashboard-analytics" style={{ marginTop: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, borderBottom: "1px solid var(--separator-soft)", paddingBottom: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
            <Cpu size={12} color="var(--secondary)" />
            Diagnostics & Live Analytics
          </div>
          <div style={{ display: "flex", alignItems: "center", fontSize: 11, fontWeight: 500 }}>
            <span className={`live-pulse ${
              sysStats?.app_state === "Transcribing" ? "pulse-transcribing" :
              sysStats?.app_state === "Recording" ? "pulse-recording" : "pulse-idle"
            }`}></span>
            State: <span style={{ fontWeight: 600, marginLeft: 3, color: sysStats?.app_state === "Transcribing" ? "var(--accent)" : sysStats?.app_state === "Recording" ? "var(--danger)" : "var(--secondary)" }}>
              {sysStats?.app_state ?? "Idle"}
            </span>
          </div>
        </div>

        <div className="grid cols-4" style={{ gap: 10 }}>
          {/* CPU Stats */}
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ fontSize: 10, color: "var(--secondary)", textTransform: "uppercase", letterSpacing: "0.2px" }}>CPU Load</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
              <span style={{ fontSize: 18, fontWeight: 700 }}>{(sysStats?.process_cpu ?? 0.0).toFixed(1)}%</span>
              <span style={{ fontSize: 10, color: "var(--tertiary)" }}>app</span>
            </div>
            <div style={{ fontSize: 9, color: "var(--tertiary)" }}>
              System Total: {(sysStats?.system_cpu ?? 0.0).toFixed(0)}%
            </div>
          </div>

          {/* Memory Stats */}
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ fontSize: 10, color: "var(--secondary)", textTransform: "uppercase", letterSpacing: "0.2px" }}>Memory Used</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
              <span style={{ fontSize: 18, fontWeight: 700 }}>{(sysStats?.process_memory_mb ?? 0.0).toFixed(0)}</span>
              <span style={{ fontSize: 10, color: "var(--secondary)", fontWeight: 600 }}>MB</span>
            </div>
            <div style={{ fontSize: 9, color: "var(--tertiary)" }}>
              System Load: {(sysStats?.system_memory_pct ?? 0.0).toFixed(0)}%
            </div>
          </div>

          {/* Power Consumption */}
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ fontSize: 10, color: "var(--secondary)", textTransform: "uppercase", letterSpacing: "0.2px", display: "flex", alignItems: "center", gap: 4 }}>
              <Zap size={10} color="var(--warning)" /> Power Impact
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
              <span style={{ fontSize: 18, fontWeight: 700, color: "var(--warning)" }}>{(sysStats?.estimated_power_watts ?? 0.1).toFixed(1)}</span>
              <span style={{ fontSize: 10, color: "var(--warning)", fontWeight: 600 }}>Watts</span>
            </div>
            <div style={{ fontSize: 9, color: "var(--tertiary)" }}>
              Power used while turning speech into text
            </div>
          </div>

          {/* Local Model Status */}
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ fontSize: 10, color: "var(--secondary)", textTransform: "uppercase", letterSpacing: "0.2px", display: "flex", alignItems: "center", gap: 4 }}>
              <Activity size={10} color="var(--success)" /> Status
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--success)" }}>All good</span>
            </div>
            <div style={{ fontSize: 9, color: "var(--tertiary)" }}>
              Everything runs on your computer
            </div>
          </div>
        </div>

        {/*
          Recording limits. The 10 minutes below mirrors MAX_RECORDING_SECS in
          src-tauri/src/audio.rs — change both together.
        */}
        <div className="dashboard-limits">
          <div className="dashboard-limit-note">
            <Scissors size={12} color="var(--warning)" />
            <p>
              <strong>One recording holds up to 10 minutes.</strong> If you keep talking past that,
              the oldest audio is dropped to make room — so on a very long take it's the{" "}
              <em>beginning</em> that gets cut off, not the end.
            </p>
          </div>
          <div className="dashboard-limit-note">
            <Hourglass size={12} color="var(--accent)" />
            <p>
              <strong>Longer recordings take longer to transcribe.</strong> The wait after you stop
              scales with how long you spoke, so a 10-minute take takes noticeably longer to come
              back than a short one.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
