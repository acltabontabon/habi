/**
 * The page's only script, no framework. Everything reads without it; every
 * scene plays once (or follows the scroll), and nothing moves forever.
 */
import { film } from "./film";
import { reel } from "./reel";
import { cloth } from "./hero";
import { tour } from "./tour";

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
      ticking = false;
    });
  },
  { passive: true },
);

/* The hero's cloth. */
const hero = document.querySelector<HTMLElement>("[data-cloth]");
if (hero) cloth(hero, reduce);

/* The film, its strip in the hero, and how it works. */
const demo = document.querySelector<HTMLDialogElement>("dialog[data-demo]");
if (demo) film(demo);

const strip = document.querySelector<HTMLElement>("[data-reel]");
if (strip) reel(strip, reduce);

const walk = document.querySelector<HTMLElement>("[data-tour]");
if (walk) tour(walk, reduce);
