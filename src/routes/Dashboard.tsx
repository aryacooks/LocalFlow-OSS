import { useEffect, useState } from "react";
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
import { Mic, Timer, TrendingUp, Cpu, Zap, Activity } from "lucide-react";
import InfoCircleIcon from "../components/ui/info-circle-icon";
import { DashboardStats, getDashboardStats, getSystemStats, SystemStats, getSetting, setSetting } from "../lib/ipc";
import { keyLabel } from "../lib/utils";
import { useAppStore } from "../lib/store";

const CHART_COLORS = ["#007aff", "#34c759", "#5ac8fa", "#ff9500", "#af52de", "#8e8e93"];

const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);

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
    <div className="glass-panel" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", position: "relative", minHeight: 185 }}>
      <span className="stat-label">Words Per Minute</span>
      <span className="stat-value" style={{ fontSize: 34, fontWeight: 700, margin: "2px 0 6px 0", letterSpacing: "-1px" }}>
        {wpm > 0 ? Math.round(wpm) : "--"}
      </span>
      <div style={{ position: "relative", width: 140, height: 75, overflow: "hidden" }}>
        <svg width="140" height="75" viewBox="0 0 140 70">
          <defs>
            <linearGradient id="wpm-arc-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#d66a2a" />
              <stop offset="100%" stopColor="#eedca7" />
            </linearGradient>
          </defs>
          <path
            d="M 10 65 A 60 60 0 0 1 130 65"
            fill="none"
            stroke="var(--quaternary)"
            strokeWidth="9"
            strokeLinecap="round"
          />
          <path
            d="M 10 65 A 60 60 0 0 1 130 65"
            fill="none"
            stroke="url(#wpm-arc-gradient)"
            strokeWidth="9"
            strokeLinecap="round"
            strokeDasharray="188.5"
            strokeDashoffset={188.5 - (188.5 * pct) / 100}
            style={{ transition: "stroke-dashoffset 0.8s ease-out" }}
          />
        </svg>
        <div style={{ position: "absolute", bottom: 4, left: 0, right: 0, textAlign: "center", display: "flex", flexDirection: "column", gap: 1 }}>
          <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.5px", color: "var(--secondary)", fontWeight: 500 }}>{text}</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--success)" }}>{badge}</span>
        </div>
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
    <div className="glass-panel" style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 185 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
        <span className="row-title" style={{ fontSize: 13, fontWeight: 600, color: "var(--label)" }}>Activity Streak</span>
        <span className="stat-footnote" style={{ fontSize: 11 }}>
          Current: <strong style={{ color: "var(--accent)" }}>{currentStreak}d</strong> | Max: <strong>{longestStreak}d</strong>
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 3, width: "100%", overflow: "hidden", padding: 4 }}>
        {/* Month labels */}
        <div style={{ display: "flex", gap: 3, paddingLeft: 18, height: 12 }}>
          {columnMonths.map((m, idx) => (
            <div key={idx} style={{ width: 10, fontSize: 8, color: "var(--secondary)", textAlign: "left", whiteSpace: "nowrap" }}>
              {m}
            </div>
          ))}
        </div>

        {/* Rows of days */}
        {[0, 1, 2, 3, 4, 5, 6].map((rowIdx) => (
          <div key={rowIdx} style={{ display: "flex", alignItems: "center", gap: 3 }}>
            {/* Day name */}
            <div style={{ width: 14, fontSize: 8, color: "var(--tertiary)", fontWeight: 600, textAlign: "center" }}>
              {daysOfWeek[rowIdx]}
            </div>

            {/* Squares */}
            {cols.map((col, colIdx) => {
              const day = col[rowIdx];
              let bgColor = "var(--quaternary)";
              let border = "none";
              
              if (day.isFuture) {
                bgColor = "transparent";
              } else if (day.words > 0) {
                const opacity = Math.min(0.25 + (day.words / 250), 1.0);
                bgColor = `rgba(48, 209, 88, ${opacity})`;
              }

              if (day.isToday) {
                border = "1.5px solid var(--accent)";
              }

              const dateStr = day.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
              const tooltipText = day.words > 0 
                ? `${day.words} words on ${dateStr}`
                : `No words on ${dateStr}`;
              
              const isAnimeBorder = day.words > 120;
              const cellClass = `streak-cell ${isAnimeBorder ? "anime-cell-border" : ""}`;

              return (
                <div
                  key={colIdx}
                  className={cellClass}
                  data-tooltip={tooltipText}
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    backgroundColor: bgColor,
                    border: border,
                    boxSizing: "border-box",
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
      
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 4, fontSize: 8, color: "var(--secondary)", marginTop: 2 }}>
        <span>Less</span>
        <div style={{ width: 7, height: 7, borderRadius: 1, backgroundColor: "var(--quaternary)" }} />
        <div style={{ width: 7, height: 7, borderRadius: 1, backgroundColor: "rgba(48, 209, 88, 0.4)" }} />
        <div style={{ width: 7, height: 7, borderRadius: 1, backgroundColor: "rgba(48, 209, 88, 0.7)" }} />
        <div style={{ width: 7, height: 7, borderRadius: 1, backgroundColor: "rgba(48, 209, 88, 1.0)" }} />
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
  const [keybindMouse, setKeybindMouse] = useState("middle");
  const [keybindMouseName, setKeybindMouseName] = useState("Middle Click");
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
    getSetting("keybind_mouse").then((val) => {
      if (val) setKeybindMouse(val);
    });
    getSetting("keybind_mouse_name").then((val) => {
      if (val) setKeybindMouseName(val);
    });
  }, []);

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

  const formatMinutes = (m: number) => {
    if (m === 0) return "0 min";
    if (m < 60) return `${Math.round(m)} min`;
    const h = Math.floor(m / 60);
    const min = Math.round(m % 60);
    return `${h}h ${min}m`;
  };

  const last7DaysData = stats?.words_per_day?.slice(-7) ?? [];

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
    <div className="page" style={{ paddingBottom: 15 }}>
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
        <div className="banner-card" style={{ backgroundImage: "url('/red extra.png')" }}>
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

      <div className="page-header">
        <div>
          <p className="page-kicker">Workspace Overview</p>
          <h2 className="page-title">Your dictation dashboard</h2>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 10 }}>
            {[
              { label: "Toggle", keys: shortcutToggle.split("+") },
              { label: "Instant", keys: keybindKeyboardName.split("+") },
              ...(keybindMouse !== "none" ? [{ label: "Mouse", keys: [keybindMouseName] }] : []),
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

      {lastTranscript && (
        <section className="glass-panel" style={{ marginBottom: 12 }}>
          <div className="section-label">Last transcription</div>
          <p style={{ margin: 0, color: "var(--label)", fontSize: 14, lineHeight: "20px", fontWeight: 500 }}>
            {lastTranscript.cleaned}
          </p>
        </section>
      )}

      <div className="glass-panel" style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 12 }}>
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
      <div className="grid cols-3" style={{ marginBottom: 12, gap: 12 }}>
        {/* WPM percentiles */}
        <WpmGauge wpm={stats?.avg_wpm_7d ?? 0} />

        {/* Streak calendar */}
        <StreakCalendar
          wordsPerDay={stats?.words_per_day ?? []}
          currentStreak={stats?.streak_days ?? 0}
          longestStreak={stats?.longest_streak ?? 0}
        />

        {/* Core numbers */}
        <div className="glass-panel" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: 185 }}>
          <div>
            <div className="stat-label">Words Today</div>
            <div className="stat-value" style={{ fontSize: 32, fontWeight: 700, margin: "2px 0 10px 0" }}>
              {(stats?.words_today ?? 0).toLocaleString()}
            </div>
          </div>
          <div style={{ borderTop: "1px solid var(--separator-soft)", paddingTop: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <Timer size={14} color="var(--accent)" />
              <span className="stat-label" style={{ fontSize: 11 }}>Time Saved</span>
            </div>
            <div className="stat-value accent" style={{ fontSize: 26, fontWeight: 700, color: "var(--accent)" }}>
              {formatMinutes(stats?.time_saved_minutes ?? 0)}
            </div>
            <span className="stat-footnote" style={{ fontSize: 10, display: "block", marginTop: 2 }}>
              Dictations recorded: {(stats?.total_dictations ?? 0).toLocaleString()} (versus 60wpm typing).
            </span>
          </div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 12, gap: 12 }}>
        {/* Total lifetime words dictated & chart */}
        <div className="glass-panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div className="stat-label">Total Lifetime Dictations</div>
            <div className="stat-value" style={{ fontSize: 28, fontWeight: 700 }}>
              {(stats?.total_words ?? 0).toLocaleString()} <span style={{ fontSize: 14, fontWeight: 500, color: "var(--secondary)" }}>words</span>
            </div>
          </div>
          
          <div style={{ height: 110, width: "100%" }}>
            <div className="section-label" style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, marginBottom: 6 }}>
              <TrendingUp size={12} /> Words (Last 7 days)
            </div>
            {last7DaysData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={last7DaysData}>
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 9, fill: "var(--secondary)" }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => v.slice(8)} // just display DD
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--panel-solid)",
                      borderColor: "var(--separator)",
                      borderRadius: 6,
                      fontSize: 11,
                      color: "var(--label)",
                    }}
                  />
                  <Line type="monotone" dataKey="words" stroke="var(--accent)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: "100%", display: "grid", placeItems: "center", fontSize: 11, color: "var(--tertiary)" }}>
                No historical data
              </div>
            )}
          </div>
        </div>

        {/* Top apps usage & toggles */}
        <div className="glass-panel" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 8 }}>
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
              ) : stats && stats.top_apps && stats.top_apps.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.top_apps.slice(0, 3)} layout="vertical" barSize={10}>
                    <XAxis type="number" hide />
                    <YAxis
                      type="category"
                      dataKey="app_name"
                      tick={{ fontSize: 10, fill: "var(--secondary)" }}
                      axisLine={false}
                      tickLine={false}
                      width={80}
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
                      {stats.top_apps.slice(0, 3).map((_, index) => (
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
      <section className="glass-panel" style={{ marginTop: 12 }}>
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
      </section>
    </div>
  );
}
