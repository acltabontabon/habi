/**
 * The page's only script, no framework. Everything reads without it; every
 * scene plays once (or follows the scroll), and nothing moves forever.
 */
import { download } from "./download";
import { hero } from "./hero";
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

/* The header's "ha·bi, to weave" steps aside while the page's own definition of it is in view. */
const lexeme = document.querySelector<HTMLElement>(".lexeme");
const aside = document.querySelector<HTMLElement>(".top-def");
if (lexeme && aside && "IntersectionObserver" in window) {
  new IntersectionObserver(([e]) => aside.classList.toggle("is-quiet", Boolean(e?.isIntersecting)), {
    rootMargin: "-60px 0px 0px 0px",
  }).observe(lexeme);
}

/* The hero, with the film in its word, and how it works. */
const cut = document.querySelector<HTMLElement>("[data-hero]");
if (cut) hero(cut, reduce);

const walk = document.querySelector<HTMLElement>("[data-tour]");
if (walk) tour(walk, reduce);

/* The Download buttons, pointed at the installer for this system. */
void download();
