/**
 * "On this page": the headings of the document being read, beside it.
 *
 * A hairline runs down the outline the way a library's thread runs down
 * its index; the section in view is crossed by the saffron weft. Choosing
 * a heading scrolls the reader to it. It reads the rendered document, so
 * it follows whichever surface is showing — SKILL.md or one prose file —
 * and stays out of the way when a document has fewer than three sections.
 */
import { type RefObject, useEffect, useRef, useState } from "react";

type Heading = { el: HTMLElement; text: string; level: number };

/** The nearest ancestor that scrolls. */
function scroller(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

function visibleDoc(root: HTMLElement): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>(".reader-doc")].find((d) => d.offsetParent !== null) ?? null;
}

function read(root: HTMLElement): Heading[] {
  const doc = visibleDoc(root);
  if (!doc) return [];
  return [...doc.querySelectorAll<HTMLElement>("h1, h2, h3")]
    .map((el) => ({ el, text: el.textContent?.trim() ?? "", level: Number(el.tagName.slice(1)) }))
    .filter((h) => h.text);
}

const MIN_SECTIONS = 3;

export function Outline({ root, watch }: { root: RefObject<HTMLElement | null>; watch: unknown }) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLOListElement>(null);

  // Rebuild when the document renders or the surface changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `watch` marks a change of surface.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let frame = 0;
    const rebuild = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setHeadings(read(el)));
    };
    rebuild();
    const observer = new MutationObserver(rebuild);
    observer.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [root, watch]);

  // The section in view: the last heading above the upper third of the reader.
  useEffect(() => {
    const box = scroller(root.current);
    if (!box || headings.length < MIN_SECTIONS) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const line = box.getBoundingClientRect().top + box.clientHeight * 0.3;
        let current = 0;
        headings.forEach((h, i) => {
          if (h.el.getBoundingClientRect().top <= line) current = i;
        });
        setActive(current);
      });
    };
    onScroll();
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      box.removeEventListener("scroll", onScroll);
    };
  }, [root, headings]);

  // Keep the current section visible in a long outline, without moving the page.
  useEffect(() => {
    const ol = list.current;
    const item = ol?.children[active] as HTMLElement | undefined;
    if (!ol || !item) return;
    const top = item.offsetTop - ol.offsetTop;
    if (top < ol.scrollTop || top > ol.scrollTop + ol.clientHeight - item.offsetHeight) {
      ol.scrollTop = top - ol.clientHeight / 3;
    }
  }, [active]);

  if (headings.length < MIN_SECTIONS) return null;
  const top = Math.min(...headings.map((h) => h.level));
  const reduce =
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return (
    <nav className="outline" aria-label="On this page">
      <p className="kicker">On this page</p>
      <ol ref={list}>
        {headings.map((h, i) => (
          <li key={i} className={`outline-item is-level-${Math.min(3, h.level - top + 1)}`}>
            <button
              type="button"
              className={i === active ? "is-active" : undefined}
              aria-current={i === active ? "location" : undefined}
              onClick={() => h.el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" })}
            >
              {h.text}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
