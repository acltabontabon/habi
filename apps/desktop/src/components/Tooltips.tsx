/**
 * Every tooltip in the app, drawn one way. Elements keep saying what they
 * are with a plain `title` (or, for a richer card, `tip()`); this layer takes
 * that over on hover or keyboard focus, so the system's grey box never shows
 * and every tooltip shares the app's surface, type and motion.
 *
 * What a title said for assistive technology is kept: an element named only
 * by its title is given that name as its label; any other gets it as its
 * description. A trailing shortcut — "(⌘,)" — becomes a key; "A — B" becomes
 * a line and a quieter second line.
 */
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** A tooltip with some structure: a name, a few lines, and a closing note. */
export type RichTip = {
  title: string;
  /** A color (a CSS value) for the small mark beside the title — a library's dye. */
  mark?: string;
  /** Dashed mark: a community library. */
  stitched?: boolean;
  /** A word set as a small badge after the title ("community"). */
  badge?: string;
  lines?: { text: string; mono?: boolean }[];
  note?: { text: string; tone?: "ok" | "warn" | "danger" | "muted" | "unknown" };
};

/** Attributes for a rich tooltip: spread them on the element. */
export function tip(rich: RichTip): Record<string, string> {
  return { "data-tip-rich": JSON.stringify(rich) };
}

type Side = "bottom" | "top" | "right";
type Shown = { content: Parsed; anchor: DOMRect; side: Side };
type Parsed = { rich: RichTip } | { text: string; detail?: string; keys?: string };

const SHORTCUT = /\s*\(((?:⌘|⌥|⇧|⌃|Esc|Enter|F\d|Ctrl)[^)]*)\)\s*$/;

function parse(el: HTMLElement): Parsed | null {
  const rich = el.dataset.tipRich;
  if (rich) {
    try {
      return { rich: JSON.parse(rich) as RichTip };
    } catch {
      return null;
    }
  }
  let text = (el.dataset.tip ?? "").trim();
  if (!text) return null;
  const keys = SHORTCUT.exec(text)?.[1];
  if (keys) text = text.replace(SHORTCUT, "");
  const dash = text.indexOf(" — ");
  if (dash > 0 && dash < 48) return { text: text.slice(0, dash), detail: text.slice(dash + 3), keys };
  return { text, keys };
}

/** What the layer filled in for assistive technology, so it can take back exactly that. */
const filled = new WeakMap<HTMLElement, { attr: "aria-label" | "aria-description"; value: string }>();
/** Elements whose `title` the layer holds (emptied, not removed: see `takeTitle`). */
const adopted = new WeakSet<HTMLElement>();

function fill(el: HTMLElement, attr: "aria-label" | "aria-description", value: string) {
  el.setAttribute(attr, value);
  filled.set(el, { attr, value });
}

/** Removes what the layer filled in, leaving anything the element's owner set since. */
function unfill(el: HTMLElement) {
  const f = filled.get(el);
  if (!f) return;
  if (el.getAttribute(f.attr) === f.value) el.removeAttribute(f.attr);
  filled.delete(el);
}

function richWords(rich: string): string {
  try {
    const r = JSON.parse(rich) as RichTip;
    return [r.badge, ...(r.lines ?? []).map((l) => l.text), r.note?.text].filter(Boolean).join(". ");
  } catch {
    return "";
  }
}

/** Moves a `title` into the layer's hands, keeping what it said for assistive technology. */
function adopt(el: HTMLElement) {
  const title = el.getAttribute("title");
  if (title !== null && !(title === "" && adopted.has(el))) takeTitle(el, title);
  else if (!adopted.has(el)) describeRich(el);
}

function takeTitle(el: HTMLElement, title: string) {
  unfill(el);
  adopted.add(el);
  // Emptied rather than removed: an empty title shows no system tooltip, and
  // when the owner later changes or drops it, the change is there to observe.
  el.setAttribute("title", "");
  el.dataset.tip = title;
  if (!title.trim()) return;
  const named = el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby");
  const words = (el.textContent ?? "").trim();
  if (!named && !words) fill(el, "aria-label", title);
  else if (!el.hasAttribute("aria-description") && words !== title) fill(el, "aria-description", title);
}

/** A rich card is described by its lines, for those who do not see it. */
function describeRich(el: HTMLElement) {
  const rich = el.dataset.tipRich;
  const words = rich ? richWords(rich) : "";
  if (filled.get(el)?.value === words) return;
  unfill(el);
  if (words && !el.hasAttribute("aria-description")) fill(el, "aria-description", words);
}

/** The owner dropped the title: the tip, and what it said, go with it. */
function release(el: HTMLElement) {
  unfill(el);
  adopted.delete(el);
  delete el.dataset.tip;
}

function holder(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>("[title], [data-tip], [data-tip-rich]");
  if (!el || el.closest("[data-tip-off]")) return null;
  return el;
}

function sideFor(el: HTMLElement): Side {
  const asked = el.closest<HTMLElement>("[data-tip-side]")?.dataset.tipSide;
  if (asked === "right" || asked === "top" || asked === "bottom") return asked;
  return el.closest(".sidebar") ? "right" : "bottom";
}

const DELAY = 450;
/** Moving from one tooltip to the next shows the next at once. */
const WARM = 400;

export function Tooltips() {
  const [shown, setShown] = useState<Shown | null>(null);
  const current = useRef<HTMLElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const lastHidden = useRef(0);
  /** What the pointer is over, so a tip that arrives later (fetched on hover) still shows. */
  const pointed = useRef<Element | null>(null);

  useEffect(() => {
    const hide = () => {
      window.clearTimeout(timer.current);
      if (current.current) lastHidden.current = Date.now();
      current.current = null;
      setShown(null);
    };
    const show = (el: HTMLElement, immediate: boolean) => {
      adopt(el);
      const content = parse(el);
      window.clearTimeout(timer.current);
      if (!content) return;
      current.current = el;
      const open = () => {
        if (current.current !== el || !el.isConnected) return;
        setShown({ content, anchor: el.getBoundingClientRect(), side: sideFor(el) });
      };
      const warm = Date.now() - lastHidden.current < WARM;
      if (immediate || warm) open();
      else timer.current = window.setTimeout(open, DELAY);
    };

    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      pointed.current = e.target instanceof Element ? e.target : null;
      const el = holder(e.target);
      if (!el) return;
      // Take the title at once, before the system shows its own.
      adopt(el);
      if (el !== current.current) show(el, false);
    };
    const out = (e: PointerEvent) => {
      const el = current.current;
      if (el && !(e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) hide();
    };
    const focus = (e: FocusEvent) => {
      const el = holder(e.target);
      if (el?.matches(":focus-visible")) show(el, false);
    };
    const blur = () => hide();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && current.current) hide();
    };

    const late = new MutationObserver((records) => {
      // A title the layer holds was changed or dropped by its owner (React
      // removes a prop's attribute, and knows nothing of the copies made here).
      for (const r of records) {
        const el = r.target;
        if (!(el instanceof HTMLElement)) continue;
        if (r.attributeName === "title" && adopted.has(el)) {
          const title = el.getAttribute("title");
          if (title === null) {
            release(el);
            if (current.current === el) hide();
          } else if (title !== "") {
            takeTitle(el, title);
            // A tip on screen says the new words at once.
            const content = current.current === el ? parse(el) : null;
            if (content) setShown((s) => (s ? { ...s, content } : s));
          }
        } else if (r.attributeName === "data-tip-rich" && filled.has(el) && !adopted.has(el)) {
          describeRich(el);
        }
      }
      // A tip given to the element under the pointer after it arrived.
      const target = pointed.current;
      if (!target?.isConnected) return;
      for (const r of records) {
        if (!(r.target instanceof HTMLElement) || !r.target.contains(target)) continue;
        const el = holder(target);
        if (el && el !== current.current) show(el, false);
        return;
      }
    });
    late.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-tip", "data-tip-rich", "title"],
    });

    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", out, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", blur, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.clearTimeout(timer.current);
      late.disconnect();
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", out, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", blur, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);

  if (!shown) return null;
  return createPortal(<Bubble shown={shown} />, document.body);
}

const GAP = 8;
const EDGE = 8;

function Bubble({ shown }: { shown: Shown }) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ x: number; y: number; side: Side; arrow: number } | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const a = shown.anchor;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let side = shown.side;
    if (side === "right" && a.right + GAP + width > vw - EDGE) side = "bottom";
    if (side === "bottom" && a.bottom + GAP + height > vh - EDGE) side = "top";
    let x: number;
    let y: number;
    let arrow: number;
    if (side === "right") {
      x = a.right + GAP;
      y = Math.min(Math.max(EDGE, a.top + a.height / 2 - height / 2), vh - EDGE - height);
      arrow = a.top + a.height / 2 - y;
    } else {
      x = Math.min(Math.max(EDGE, a.left + a.width / 2 - width / 2), vw - EDGE - width);
      y = side === "bottom" ? a.bottom + GAP : a.top - GAP - height;
      arrow = a.left + a.width / 2 - x;
    }
    setPlace({ x, y, side, arrow });
  }, [shown]);

  const c = shown.content;
  return (
    <div
      ref={box}
      className={`tip is-${place?.side ?? shown.side}${place ? " is-placed" : ""}`}
      role="tooltip"
      style={
        {
          left: place?.x ?? -9999,
          top: place?.y ?? -9999,
          "--tip-arrow": `${place?.arrow ?? 0}px`,
        } as CSSProperties
      }
    >
      {"rich" in c ? (
        <>
          <p className="tip-title">
            {c.rich.mark ? (
              <span
                className={`tip-mark${c.rich.stitched ? " is-stitched" : ""}`}
                style={{ "--mark": c.rich.mark } as CSSProperties}
                aria-hidden="true"
              />
            ) : null}
            {c.rich.title}
            {c.rich.badge ? <span className="tip-badge">{c.rich.badge}</span> : null}
          </p>
          {(c.rich.lines ?? []).map((l, i) => (
            <p key={i} className={`tip-line${l.mono ? " mono" : ""}`}>
              {l.text}
            </p>
          ))}
          {c.rich.note ? (
            <p className={`tip-note tone-${c.rich.note.tone ?? "muted"}`}>
              <span className="tip-note-dot" aria-hidden="true" />
              {c.rich.note.text}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="tip-text">
            <span>{c.text}</span>
            {c.keys ? <kbd className="tip-keys">{c.keys}</kbd> : null}
          </p>
          {c.detail ? <p className="tip-line">{c.detail}</p> : null}
        </>
      )}
    </div>
  );
}
