import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";
import { getAppIcon, getSetting, listKnownApps, setSetting, type KnownApp } from "../lib/ipc";

/** Settings → Privacy → "See how it looks": your screen next to what a call sees. */
export function CaptureExample() {
  return (
    <div className="capture-example" aria-label="Example: what you see and what others see">
      {[
        { title: "On your screen", note: "You see the orb and the copy card as usual.", own: true },
        { title: "What others see", note: "On Zoom, Meet or a recording they're simply not there.", own: false },
      ].map((s) => (
        <figure key={s.title} className="capture-shot">
          <div className="capture-screen">
            <div className="capture-window">
              <div className="capture-dots"><i /><i /><i /></div>
              <div className="capture-line w70" />
              <div className="capture-line w90" />
              <div className="capture-line w50" />
            </div>
            {s.own ? (
              <>
                <div className="capture-card">
                  <b>Nothing to paste</b>
                  <span>Remind me to call the bank…</span>
                  <em>Copy</em>
                </div>
                <div className="capture-orb" />
              </>
            ) : (
              <>
                <div className="capture-card ghost" />
                <div className="capture-orb ghost" />
              </>
            )}
          </div>
          <figcaption>
            <strong>{s.title}</strong>
            <span>{s.note}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

function AppChipIcon({ app }: { app: KnownApp }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getAppIcon(app.name, app.exe).then((s) => { if (live) setSrc(s ?? null); }).catch(() => {});
    return () => { live = false; };
  }, [app.name, app.exe]);
  if (src) return <img src={src} alt="" />;
  return <span className="nosave-letter">{app.name.charAt(0).toUpperCase()}</span>;
}

/** Settings → Privacy → "Don't save from these apps" (setting `nosave_apps`, a JSON list of names). */
export function NoSaveApps() {
  const [apps, setApps] = useState<string[]>([]);
  const [known, setKnown] = useState<KnownApp[]>([]);

  useEffect(() => {
    getSetting("nosave_apps")
      .then((v) => {
        try { const a = JSON.parse(v ?? "[]"); if (Array.isArray(a)) setApps(a.filter((x) => typeof x === "string")); }
        catch { /* keep empty */ }
      })
      .catch(() => {});
    listKnownApps().then(setKnown).catch(() => {});
  }, []);

  const update = (next: string[]) => {
    setApps(next);
    setSetting("nosave_apps", JSON.stringify(next)).catch(console.error);
  };
  const lower = new Set(apps.map((a) => a.toLowerCase()));
  const exeOf = (name: string) => known.find((k) => k.name.toLowerCase() === name.toLowerCase())?.exe ?? "";

  return (
    <div className="nosave">
      {apps.length > 0 && (
        <ul className="nosave-list">
          {apps.map((name) => (
            <li key={name} className="nosave-chip">
              <AppChipIcon app={{ name, exe: exeOf(name) }} />
              <span>{name}</span>
              <button type="button" aria-label={`Start saving ${name} again`} onClick={() => update(apps.filter((a) => a !== name))}>
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <AppSearch
        apps={known.filter((k) => !lower.has(k.name.toLowerCase()))}
        onPick={(name) => update([...apps, name])}
      />
    </div>
  );
}

/** Type to filter the apps; Enter or click adds one. A name that isn't listed
 *  (an app that isn't open) can be added as typed. */
export function AppSearch({ apps, onPick }: { apps: KnownApp[]; onPick: (name: string) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean; maxH: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const query = q.trim().toLowerCase();
  const matches = apps.filter((a) => a.name.toLowerCase().includes(query));
  const exact = apps.some((a) => a.name.toLowerCase() === query);
  const items: { name: string; custom?: boolean }[] = [
    ...matches.map((a) => ({ name: a.name })),
    ...(query && !exact ? [{ name: q.trim(), custom: true }] : []),
  ];

  const place = () => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 200 && above > below;
    const width = r.width;
    const left = Math.min(r.left, window.innerWidth - width - 12);
    setPos({ left, top: up ? r.top - 6 : r.bottom + 6, width, up, maxH: Math.min(280, up ? above : below) });
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (list.current && e.target instanceof Node && list.current.contains(e.target)) return;
      place();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const pick = (name: string) => {
    onPick(name);
    setQ("");
    setActive(0);
    input.current?.focus();
  };

  return (
    <div ref={box} className="app-search">
      <Search size={14} className="app-search-icon" aria-hidden="true" />
      <input
        ref={input}
        type="text"
        value={q}
        placeholder="Search apps to add…"
        aria-label="Search apps to add"
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
        spellCheck={false}
        onFocus={() => { place(); setOpen(true); }}
        onChange={(e) => { setQ(e.target.value); setActive(0); place(); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((i) => Math.min(items.length - 1, i + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
          else if (e.key === "Enter") { e.preventDefault(); if (items[active]) pick(items[active].name); }
          else if (e.key === "Escape") { setOpen(false); }
        }}
      />
      {open && pos && items.length > 0 && createPortal(
        <ul
          ref={list}
          role="listbox"
          className={`dropdown-list ${pos.up ? "is-up" : ""}`}
          style={{
            left: pos.left,
            width: pos.width,
            maxHeight: pos.maxH,
            ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
          }}
        >
          {items.map((it, i) => (
            <li
              key={(it.custom ? "+" : "") + it.name}
              data-i={i}
              role="option"
              aria-selected={i === active}
              className={`dropdown-item ${i === active ? "is-active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(it.name); }}
            >
              <span className="dropdown-item-text"><span>{it.custom ? `Add “${it.name}”` : it.name}</span></span>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  );
}
