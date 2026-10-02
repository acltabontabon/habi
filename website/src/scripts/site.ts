/**
 * The page's only script, no framework. Everything reads without it; every
 * scene plays once (or follows the scroll), and nothing moves forever.
 */
import { cloth } from "./hero";
import { scene } from "./scene";

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Sections come in once, when they are in view. */
const reveal = document.querySelectorAll<HTMLElement>("[data-reveal]");
if (reduce || !("IntersectionObserver" in window)) {
  for (const el of reveal) el.classList.add("is-in");
} else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-in");
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -20% 0px", threshold: 0.1 },
  );
  for (const el of reveal) io.observe(el);
}

/* The bridge to how it works: scrolling pulls the thread down. */
const bridge = document.querySelector<HTMLElement>("[data-bridge]");
const pull = () => {
  if (!bridge) return;
  const r = bridge.getBoundingClientRect();
  const p = Math.min(1, Math.max(0, (window.innerHeight * 0.82 - r.top) / r.height));
  bridge.style.setProperty("--pull", p.toFixed(3));
  bridge.classList.toggle("is-landed", p > 0.98);
};
if (bridge && !reduce) {
  bridge.classList.add("is-pulled");
  pull();
}

/* The header gains its hairline once the page moves. */
const top = document.querySelector<HTMLElement>("[data-top]");
let ticking = false;
window.addEventListener(
  "scroll",
  () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      top?.toggleAttribute("data-scrolled", window.scrollY > 8);
      if (!reduce) pull();
      ticking = false;
    });
  },
  { passive: true },
);

/* The hero's cloth. */
const hero = document.querySelector<HTMLElement>("[data-cloth]");
if (hero) cloth(hero, reduce);

/* The weave. */
const weave = document.querySelector<HTMLElement>("[data-scene]");
if (weave) scene(weave, reduce);

/* Receipts: tabs that play through once while on screen; touching them hands over control. */
for (const duo of document.querySelectorAll<HTMLElement>("[data-duo]")) {
  const tabs = [...duo.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const DUR = 7000;
  duo.style.setProperty("--dur", `${DUR}ms`);
  let at = 0;
  let timer = 0;
  let visible = false;
  let held = false;
  let stopped = reduce;
  const show = (i: number, focus = false) => {
    at = (i + tabs.length) % tabs.length;
    tabs.forEach((t, j) => {
      t.setAttribute("aria-selected", String(j === at));
      t.tabIndex = j === at ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls") ?? "")?.classList.toggle("is-active", j === at);
    });
    if (focus) tabs[at]?.focus();
    schedule();
  };
  const schedule = () => {
    window.clearTimeout(timer);
    if (at === tabs.length - 1) stopped = true;
    const playing = visible && !held && !stopped;
    duo.toggleAttribute("data-playing", playing);
    if (playing) timer = window.setTimeout(() => show(at + 1), DUR);
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => {
      stopped = true;
      show(i);
    });
    t.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        stopped = true;
        show(e.key === "Home" ? 0 : tabs.length - 1, true);
      } else if (d) {
        e.preventDefault();
        stopped = true;
        show(at + d, true);
      }
    });
  });
  duo.addEventListener("pointerenter", () => {
    held = true;
    schedule();
  });
  duo.addEventListener("pointerleave", () => {
    held = false;
    schedule();
  });
  duo.addEventListener("focusin", () => {
    held = true;
    schedule();
  });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(
      ([e]) => {
        visible = Boolean(e?.isIntersecting);
        schedule();
      },
      { threshold: 0.45 },
    ).observe(duo);
  }
}
