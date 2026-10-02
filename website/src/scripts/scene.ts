/**
 * The weave, played by scrolling. One function of progress (0…1) places
 * every thread; nothing moves unless the page does, and nothing runs while
 * the scene is off screen. With reduced motion the scene is shown woven.
 */

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const span = (p: number, a: number, b: number) => clamp((p - a) / (b - a));

/** Where each caption begins. */
const STEPS = [0, 0.32, 0.48, 0.64, 0.84];
/** The scene opens with the pieces already scattered, ready to gather. */
const START = 0.1;
const WARP_X = [210, 305, 400, 495];
const WEFT_Y = [196, 264, 332, 400];
const TOP = 110;
const BOTTOM = 450;
const LEFT = 170;
const RIGHT = 545;
const CARD_Y = 268;
/** Habi's mark, drawn from the cloth: centre and size in stage units. */
const MARK = { cx: 320, cy: 262, s: 230 };

export function scene(root: HTMLElement, reduce: boolean) {
  const q = <T extends Element>(s: string) => [...root.querySelectorAll<T>(s)];
  const one = <T extends Element>(s: string) => root.querySelector<T>(s) as T;
  const captions = q<HTMLElement>(".caption");
  const ticks = q<HTMLElement>("[data-tick]");
  const warps = q<SVGLineElement>("[data-warp]");
  const wefts = q<SVGGElement>("[data-weft]");
  const floats = q<SVGRectElement>("[data-float]");
  const frags = q<HTMLElement>("[data-frag]");
  const sources = q<HTMLElement>("[data-label-warp]");
  const repos = q<HTMLElement>("[data-label-weft]");
  const card = one<HTMLElement>(".s-card");
  const cardLines = q<HTMLElement>(".s-card li");
  const loop = one<SVGPathElement>(".s-loop");
  const knot = one<SVGCircleElement>(".s-knot");
  const bead = one<SVGCircleElement>(".s-bead");
  const evidence = one<HTMLElement>(".is-evidence");
  const refine = one<HTMLElement>(".is-refine");
  const update = one<HTMLElement>(".is-update");
  const ground = one<SVGRectElement>(".s-mark-ground");
  const cut = one<SVGLineElement>(".s-mark-cut-left");
  const over = one<SVGLineElement>(".s-mark-over");

  const { cx, cy, s } = MARK;
  const mk = {
    left: cx - 0.1445 * s,
    right: cx + 0.1445 * s,
    top: cy - 0.2695 * s,
    bottom: cy + 0.2695 * s,
    weftY: cy + 0.0078 * s,
    weftL: cx - 0.2383 * s,
    weftR: cx + 0.2383 * s,
    width: 0.0742 * s,
  };
  ground.setAttribute("x", String(cx - s / 2));
  ground.setAttribute("y", String(cy - s / 2));
  ground.setAttribute("width", String(s));
  ground.setAttribute("height", String(s));
  ground.setAttribute("rx", String(0.2266 * s));
  for (const [el, w] of [
    [cut, 0.121 * s],
    [over, mk.width],
  ] as const) {
    el.setAttribute("x1", String(mk.left));
    el.setAttribute("x2", String(mk.left));
    el.setAttribute("y1", String(mk.weftY - 0.0527 * s));
    el.setAttribute("y2", String(mk.weftY + 0.0527 * s));
    el.style.strokeWidth = String(w);
  }

  const set = (el: Element, attr: string, v: number) => el.setAttribute(attr, v.toFixed(2));
  const fade = (el: HTMLElement | SVGElement, v: number) => {
    el.style.opacity = v.toFixed(3);
  };

  let last = -1;
  const render = (p: number) => {
    if (Math.abs(p - last) < 0.0005) return;
    last = p;
    const step = STEPS.reduce((n, at, i) => (p >= at - 0.015 ? i : n), 0);
    captions.forEach((c, i) => c.classList.toggle("is-on", i === step));
    ticks.forEach((t, i) => t.classList.toggle("is-on", i <= step));

    // 06: the cloth draws together into the mark.
    const m = ease(span(p, 0.84, 0.95));
    const away = 1 - span(p, 0.82, 0.88);

    // 01 → 02: the pieces gather into one package.
    const g = ease(span(p, 0.15, 0.27));
    frags.forEach((f, i) => {
      const sx = Number(f.dataset.sx);
      const sy = Number(f.dataset.sy) - span(p, 0, 0.14) * 3 * ((i % 3) - 1);
      const x = lerp(sx, Number(f.dataset.tx), g);
      const y = lerp(sy, Number(f.dataset.ty), g);
      const r = (1 - g) * [-3, 2, -1.5, 2.5, -2][i % 5];
      f.style.transform = `translate(${x}cqw, ${y}cqh) translateY(-50%) rotate(${r}deg) scale(${lerp(1, 0.86, g)})`;
      fade(f, 1 - span(p, 0.25, 0.3));
      f.classList.toggle("is-gathering", g > 0.02);
    });

    // 02 → 03: the package becomes a thread.
    const c = ease(span(p, 0.34, 0.42));
    fade(card, span(p, 0.23, 0.28) * (1 - span(p, 0.36, 0.42)));
    card.style.transform = `translate(-50%, -50%) scale(${lerp(1, 0.04, c)}, ${lerp(1, 1.6, c)})`;
    cardLines.forEach((l, i) => fade(l, span(p, 0.25 + i * 0.015, 0.28 + i * 0.015)));

    // 03: library threads.
    warps.forEach((w, i) => {
      const t = i === 1 ? ease(span(p, 0.37, 0.45)) : ease(span(p, 0.42 + i * 0.012, 0.5 + i * 0.012));
      const y1 = i === 1 ? lerp(CARD_Y, TOP, t) : TOP;
      const y2 = i === 1 ? lerp(CARD_Y, BOTTOM, t) : lerp(TOP, BOTTOM, t);
      const keep = i === 1 || i === 2;
      if (keep && m > 0) {
        const x = i === 1 ? mk.left : mk.right;
        set(w, "x1", lerp(WARP_X[i], x, m));
        set(w, "x2", lerp(WARP_X[i], x, m));
        set(w, "y1", lerp(y1, mk.top, m));
        set(w, "y2", lerp(y2, mk.bottom, m));
        w.style.strokeWidth = lerp(3, mk.width, m).toFixed(2);
      } else {
        set(w, "x1", WARP_X[i]);
        set(w, "x2", WARP_X[i]);
        set(w, "y1", y1);
        set(w, "y2", y2);
        w.style.strokeWidth = "3";
      }
      w.classList.toggle("is-mark", keep && m > 0.55);
      fade(w, (t > 0 ? 1 : 0) * (keep ? 1 : away));
      fade(sources[i], t * (1 - span(p, 0.635, 0.655)));
    });

    // 04: projects cross the warp; floats where knowledge applies.
    wefts.forEach((row, r) => {
      const t = ease(span(p, 0.5 + r * 0.025, 0.58 + r * 0.025));
      const [halo, pick] = row.children as unknown as SVGLineElement[];
      if (r === 0 && m > 0) {
        for (const l of [halo, pick]) {
          set(l, "x1", lerp(LEFT, mk.weftL, m));
          set(l, "x2", lerp(RIGHT, mk.weftR, m));
          set(l, "y1", lerp(WEFT_Y[0], mk.weftY, m));
          set(l, "y2", lerp(WEFT_Y[0], mk.weftY, m));
        }
        pick.style.strokeWidth = lerp(5, mk.width, m).toFixed(2);
        fade(halo, 1 - m);
      } else {
        for (const l of [halo, pick]) {
          set(l, "x1", LEFT);
          set(l, "x2", lerp(LEFT, RIGHT, t));
          set(l, "y1", WEFT_Y[r]);
          set(l, "y2", WEFT_Y[r]);
        }
        pick.style.strokeWidth = "5";
        fade(halo, 1);
      }
      row.classList.toggle("is-mark", r === 0 && m > 0.35);
      fade(row, t > 0 ? (r === 0 ? 1 : away) : 0);
      fade(repos[r], t * away);
    });
    floats.forEach((f) => {
      const r = Number(f.dataset.row);
      fade(f, span(p, 0.57 + r * 0.025, 0.6 + r * 0.025) * away);
      if (r === 1 && f.dataset.col === "1") f.classList.toggle("is-updated", p > 0.785 && p < 0.86);
    });
    fade(evidence, span(p, 0.6, 0.63) * (1 - span(p, 0.655, 0.67)));

    // 05: a refinement loops out and back; the update travels.
    loop.style.strokeDashoffset = (1 - ease(span(p, 0.66, 0.72))).toFixed(3);
    fade(loop, span(p, 0.655, 0.66) * away);
    fade(refine, span(p, 0.69, 0.72) * (1 - span(p, 0.78, 0.8)));
    fade(knot, span(p, 0.715, 0.735) * away);
    const travel = ease(span(p, 0.74, 0.78));
    set(bead, "cy", lerp(WEFT_Y[0], WEFT_Y[1], travel));
    fade(bead, span(p, 0.735, 0.745) * (1 - span(p, 0.78, 0.8)));
    fade(update, span(p, 0.78, 0.8) * away);

    // 06: the mark.
    fade(ground, span(p, 0.86, 0.95));
    fade(cut, span(p, 0.93, 0.97));
    fade(over, span(p, 0.93, 0.97));
  };

  if (reduce || !("IntersectionObserver" in window)) {
    root.classList.add("is-static");
    render(0.8);
    return;
  }

  root.classList.add("is-live");
  let visible = false;
  let queued = false;
  const frame = () => {
    queued = false;
    const r = root.getBoundingClientRect();
    const total = r.height - window.innerHeight;
    render(START + (1 - START) * clamp(-r.top / (total || 1)));
  };
  const queue = () => {
    if (visible && !queued) {
      queued = true;
      requestAnimationFrame(frame);
    }
  };
  new IntersectionObserver(([e]) => {
    visible = Boolean(e?.isIntersecting);
    queue();
  }).observe(root);
  window.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", queue, { passive: true });
  render(START);
}
