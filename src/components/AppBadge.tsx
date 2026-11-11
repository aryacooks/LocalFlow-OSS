import { useEffect, useState } from "react";
import { getAppIcon } from "../lib/ipc";
import { appColor } from "../lib/utils";

/** Tidy an app name for display: strip invisible marks, unify "localflow", title-case. */
export function cleanAppName(raw: string | undefined | null): string {
  const n = (raw || "").replace(/[​-‏‪-‮⁦-⁩﻿]/g, "").trim();
  if (!n || n.toLowerCase() === "unknown") return "Unknown app";
  if (/^localflow$/i.test(n)) return "LocalFlow";
  return n === n.toLowerCase() ? n.charAt(0).toUpperCase() + n.slice(1) : n;
}

// One lookup per app, shared by everything that shows it.
const cache = new Map<string, Promise<string | null>>();
function iconFor(name: string, exe: string): Promise<string | null> {
  const key = `${name}|${exe}`;
  let p = cache.get(key);
  if (!p) {
    p = getAppIcon(name, exe).catch(() => null);
    cache.set(key, p);
  }
  return p;
}

/** The app's real icon (macOS), or a letter square in the app's colour. */
export function AppBadge({ name, exe = "", size = 20 }: { name: string; exe?: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    iconFor(name, exe).then((s) => { if (live) setSrc(s); });
    return () => { live = false; };
  }, [name, exe]);
  const box = { width: size, height: size, flexShrink: 0 } as const;
  if (src) return <img src={src} alt="" style={{ ...box, objectFit: "contain" }} />;
  return (
    <span
      aria-hidden="true"
      style={{
        ...box, borderRadius: Math.round(size * 0.26), background: appColor(exe || name),
        color: "#fff", display: "inline-grid", placeItems: "center",
        fontSize: Math.round(size * 0.5), fontWeight: 700,
      }}
    >
      {cleanAppName(name).charAt(0).toUpperCase()}
    </span>
  );
}
