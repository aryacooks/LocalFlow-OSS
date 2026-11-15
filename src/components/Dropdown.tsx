import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface DropdownOption {
  value: string;
  label: string;
  /** Small grey text under the label. */
  hint?: string;
}

interface Props {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  width?: number;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Themed replacement for <select>: the native macOS menu ignores the app's look. The
 * list opens in a portal (so card overflow can't clip it), flips above the button when
 * there's no room below, and works from the keyboard (↑ ↓ Home End Enter Esc, or type
 * a letter to jump).
 */
export default function Dropdown({ value, options, onChange, width = 260, ariaLabel, placeholder = "Choose…", disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean; maxH: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const selected = options.find((o) => o.value === value);

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const want = Math.min(320, options.length * 40 + 12);
    const up = below < want && above > below;
    setPos({ left: r.left, top: up ? r.top - 6 : r.bottom + 6, width: Math.max(r.width, 200), up, maxH: Math.min(320, up ? above : below) });
  };

  const openList = () => {
    if (disabled) return;
    place();
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };
  const pick = (v: string) => {
    if (v !== value) onChange(v);
    close();
  };

  // Close on outside click, scroll or resize (the list is positioned to the button).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !list.current?.contains(t)) close(false);
    };
    const onMove = (e: Event) => {
      if (list.current && e.target instanceof Node && list.current.contains(e.target)) return;
      close(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    list.current?.focus();
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const onListKey = (e: React.KeyboardEvent) => {
    const last = options.length - 1;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(last, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(last); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (options[active]) pick(options[active].value); }
    else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); close(); }
    else if (e.key.length === 1) {
      const k = e.key.toLowerCase();
      const from = options.findIndex((o, i) => i > active && o.label.toLowerCase().startsWith(k));
      const at = from >= 0 ? from : options.findIndex((o) => o.label.toLowerCase().startsWith(k));
      if (at >= 0) setActive(at);
    }
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`dropdown-btn ${open ? "is-open" : ""}`}
        style={{ width }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); openList(); }
        }}
      >
        <span className={`dropdown-value ${selected ? "" : "is-placeholder"}`}>{selected?.label ?? placeholder}</span>
        <ChevronDown size={16} className="dropdown-chevron" aria-hidden="true" />
      </button>
      {open && pos && createPortal(
        <ul
          ref={list}
          id={id}
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel}
          aria-activedescendant={`${id}-${active}`}
          className={`dropdown-list ${pos.up ? "is-up" : ""}`}
          style={{
            left: pos.left,
            width: pos.width,
            maxHeight: pos.maxH,
            ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
          }}
          onKeyDown={onListKey}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${id}-${i}`}
              data-i={i}
              role="option"
              aria-selected={o.value === value}
              className={`dropdown-item ${i === active ? "is-active" : ""} ${o.value === value ? "is-selected" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o.value)}
            >
              <span className="dropdown-item-text">
                <span>{o.label}</span>
                {o.hint && <small>{o.hint}</small>}
              </span>
              {o.value === value && <Check size={15} strokeWidth={2.6} aria-hidden="true" />}
            </li>
          ))}
          {options.length === 0 && <li className="dropdown-empty">Nothing to choose yet</li>}
        </ul>,
        document.body,
      )}
    </>
  );
}
