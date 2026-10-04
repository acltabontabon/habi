/**
 * How it works, followed by the scroll. Each move's window swings flat as it
 * comes up the screen (--p, 0 → 1), its pins land once it has, and the thread
 * down the side fills to wherever the reader is. With reduced motion, or
 * without scripts, the moves simply sit there, flat and pinned.
 */

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));

export function tour(root: HTMLElement, reduce: boolean) {
  const list = root.querySelector<HTMLElement>("[data-moves]");
  const moves = [...root.querySelectorAll<HTMLElement>("[data-move]")];
  const fill = root.querySelector<HTMLElement>("[data-tour-fill]");
  if (!list || !fill || reduce || !("IntersectionObserver" in window)) return;

  root.classList.add("is-live");
  let visible = false;
  let queued = false;

  const frame = () => {
    queued = false;
    const vh = window.innerHeight;
    for (const m of moves) {
      const shot = m.querySelector<HTMLElement>(".move-shot");
      const r = (shot ?? m).getBoundingClientRect();
      // 0 when the window's top is at the bottom of the screen, 1 when it has risen to 35% from the top.
      const p = clamp((vh - r.top) / (vh * 0.65));
      m.style.setProperty("--p", p.toFixed(3));
      m.classList.toggle("is-in", p > 0.92);
      m.classList.toggle("is-past", r.top < vh * 0.5);
    }
    const l = list.getBoundingClientRect();
    fill.style.setProperty("--fill", clamp((vh * 0.5 - l.top) / l.height).toFixed(3));
  };
  const queue = () => {
    if (visible && !queued) {
      queued = true;
      requestAnimationFrame(frame);
    }
  };

  new IntersectionObserver(
    ([e]) => {
      visible = Boolean(e?.isIntersecting);
      queue();
    },
    { rootMargin: "20% 0px 20% 0px" },
  ).observe(list);
  window.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", queue, { passive: true });
  frame();
}
