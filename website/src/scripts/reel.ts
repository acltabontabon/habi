/**
 * The filmstrip in the hero, running. The strip is two copies of the same
 * frames in a horizontal scroller; it drifts by itself and, past the end of the
 * first copy, steps back by exactly one copy, so the loop has no seam. It
 * stops while it is pointed at, focused, off screen or in a hidden tab, and
 * waits a moment after you have scrolled or dragged it yourself. A mouse can
 * drag it; a drag is not a click. With reduced motion it never moves by
 * itself: it is a strip you scroll.
 */

const SPEED = 28; // pixels a second
const REST = 2500; // ms to wait after a hand has moved it

export function reel(root: HTMLElement, reduce: boolean) {
  const track = root.querySelector<HTMLElement>("[data-reel-track]");
  const strip = root.querySelector<HTMLElement>(".reel-strip");
  if (!track || !strip) return;

  let pos = track.scrollLeft;
  let last = 0;
  let held = false;
  let visible = true;
  let until = 0;

  /** One copy's width, including the gap before the second. */
  const period = () => strip.offsetWidth + (parseFloat(getComputedStyle(track).columnGap) || 0);

  const wrap = () => {
    const p = period();
    if (pos >= p) pos -= p;
    if (pos < 0) pos += p;
  };

  const tick = (now: number) => {
    const dt = last ? Math.min(64, now - last) : 0;
    last = now;
    // A hand moved it: follow, and rest a moment.
    if (Math.abs(track.scrollLeft - pos) > 2) {
      pos = track.scrollLeft;
      until = now + REST;
    }
    if (!reduce && !held && visible && !document.hidden && now > until) {
      pos += (SPEED * dt) / 1000;
    }
    wrap();
    if (Math.abs(track.scrollLeft - pos) > 0.5) track.scrollLeft = pos;
    requestAnimationFrame(tick);
  };

  root.addEventListener("pointerenter", () => (held = true));
  root.addEventListener("pointerleave", () => (held = false));
  root.addEventListener("focusin", () => (held = true));
  root.addEventListener("focusout", () => (held = false));
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([e]) => (visible = Boolean(e?.isIntersecting))).observe(root);
  }

  /* A mouse drags it. More than a few pixels and it was a drag, not a click. */
  track.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const x0 = e.clientX;
    const s0 = track.scrollLeft;
    let moved = false;
    const move = (m: PointerEvent) => {
      const dx = m.clientX - x0;
      if (!moved && Math.abs(dx) > 5) {
        moved = true;
        root.classList.add("is-dragging");
        track.setPointerCapture(e.pointerId);
      }
      if (moved) {
        pos = s0 - dx;
        wrap();
        track.scrollLeft = pos;
      }
    };
    const up = () => {
      track.removeEventListener("pointermove", move);
      track.removeEventListener("pointerup", up);
      track.removeEventListener("pointercancel", up);
      root.classList.remove("is-dragging");
      if (moved) {
        until = performance.now() + REST;
        // The click that follows a drag opens nothing.
        const frame = (e.target as Element).closest<HTMLElement>("[data-film-open]");
        if (frame) {
          frame.dataset.dragged = "1";
          setTimeout(() => delete frame.dataset.dragged, 0);
        }
      }
    };
    track.addEventListener("pointermove", move);
    track.addEventListener("pointerup", up);
    track.addEventListener("pointercancel", up);
  });

  root.classList.add("is-live");
  requestAnimationFrame(tick);
}
