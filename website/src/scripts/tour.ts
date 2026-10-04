/**
 * How it works, as a journey. The six screens sit on one large plane along a
 * stitched path; the page pins a stage and, as you scroll, a camera flies
 * from screen to screen. t runs from 0 (the first screen) to the number of
 * screens (the whole plane in view): whole numbers are stops, where the camera
 * dwells, and between them it pulls back to show the route and comes in on the
 * next. The saffron thread fills in behind it with a shuttle at its tip, the
 * knots light as it reaches them, the screen it is on comes up and the rest
 * dim, and its pins land.
 *
 * With reduced motion, or without scripts, none of this runs: the moves are a
 * plain list.
 */

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const smooth = (x: number) => x * x * (3 - 2 * x);
/** Ease with a dwell at each end: stay, travel, stay. */
const dwell = (u: number) => smooth(clamp((u - 0.22) / 0.56));

export function tour(root: HTMLElement, reduce: boolean) {
  const rig = root.querySelector<HTMLElement>("[data-rig]");
  const stage = root.querySelector<HTMLElement>("[data-rig-stage]");
  const plane = root.querySelector<HTMLElement>("[data-rig-plane]");
  const wins = [...root.querySelectorAll<HTMLElement>("[data-win]")];
  const caps = [...root.querySelectorAll<HTMLElement>("[data-cap]")];
  const segs = [...root.querySelectorAll<SVGPathElement>("[data-seg]")];
  const knots = [...root.querySelectorAll<SVGCircleElement>("[data-knot]")];
  const shuttle = root.querySelector<SVGCircleElement>("[data-shuttle]");
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-go]")];
  if (!rig || !stage || !plane || !shuttle || wins.length < 2 || reduce) return;

  root.classList.add("is-rig");

  const N = wins.length;
  const pw = Number(plane.dataset.pw);
  const ph = Number(plane.dataset.ph);
  const W = Number(plane.dataset.w);
  const H = Number(plane.dataset.h);
  const centers = wins.map((w) => ({ x: Number(w.dataset.cx), y: Number(w.dataset.cy) }));
  const lengths = segs.map((s) => s.getTotalLength());

  let vw = 0;
  let vh = 0;
  let tall = false;

  const measure = () => {
    vw = stage.clientWidth;
    vh = stage.clientHeight;
    tall = vw < 820;
  };

  /** Where, and how large, a screen is when the camera is on it: to the right of the caption, or above it on a tall screen. */
  const onScreen = () =>
    tall
      ? { s: (vw * 0.9) / W, px: vw / 2, py: vh * 0.33 }
      : { s: Math.min((vw * 0.56) / W, (vh * 0.74) / H), px: vw * 0.64, py: vh * 0.5 };
  /** The whole plane in view. */
  const wholePlane = () => ({ s: Math.min((vw * 0.92) / pw, (vh * 0.68) / ph), px: vw / 2, py: vh * 0.6 });

  const camera = (t: number) => {
    const a = clamp(t, 0, N);
    const here = onScreen();
    if (a < N - 1) {
      const i = Math.floor(a);
      const f = dwell(a - i);
      const c0 = centers[i]!;
      const c1 = centers[i + 1]!;
      // Pulls back mid-flight (to 62%) so the route shows, then comes in.
      return { cx: lerp(c0.x, c1.x, f), cy: lerp(c0.y, c1.y, f), s: here.s * (1 - 0.38 * Math.sin(Math.PI * f)), px: here.px, py: here.py };
    }
    const f = dwell(a - (N - 1));
    const last = centers[N - 1]!;
    const all = wholePlane();
    return { cx: lerp(last.x, pw / 2, f), cy: lerp(last.y, ph / 2, f), s: lerp(here.s, all.s, f), px: lerp(here.px, all.px, f), py: lerp(here.py, all.py, f) };
  };

  const stick = () => parseFloat(getComputedStyle(stage).top) || 0;
  const span = () => Math.max(1, rig.offsetHeight - stage.offsetHeight);

  let ticking = false;
  const frame = () => {
    ticking = false;
    const r = rig.getBoundingClientRect();
    if (r.bottom < -vh || r.top > vh * 2) return;
    const t = clamp((stick() - r.top) / span()) * N;
    const c = camera(t);

    const x = c.px - c.cx * c.s;
    const y = c.py - c.cy * c.s;
    plane.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${c.s.toFixed(4)})`;
    // What is on the plane is drawn for the screen it is first seen on; the pins keep their size as it pulls back.
    plane.style.setProperty("--inv", clamp(1 / c.s, 1, 2.4).toFixed(2));
    stage.style.setProperty("--bs", c.s.toFixed(4));
    stage.style.setProperty("--bx", `${x.toFixed(1)}px`);
    stage.style.setProperty("--by", `${y.toFixed(1)}px`);

    // The thread, drawn as far as the camera has come, and the shuttle at its tip.
    const drawn = segs.map((seg, j) => {
      const d = t <= j ? 0 : t >= j + 1 ? 1 : dwell(t - j);
      seg.style.strokeDashoffset = (1 - d).toFixed(4);
      return d;
    });
    const j = Math.min(segs.length - 1, Math.max(0, Math.floor(t)));
    const tip = segs[j]!.getPointAtLength((drawn[j] ?? 0) * (lengths[j] ?? 0));
    shuttle.setAttribute("cx", tip.x.toFixed(1));
    shuttle.setAttribute("cy", tip.y.toFixed(1));
    for (const k of knots) k.classList.toggle("is-lit", t >= Number(k.dataset.at));

    // The screen it is on comes up; at the end, all of them.
    const whole = clamp(t - (N - 1));
    stage.classList.toggle("is-whole", whole > 0.5);
    wins.forEach((w, i) => {
      const dist = Math.abs(t - i);
      w.style.setProperty("--a", Math.max(clamp(1 - dist / 0.9), whole).toFixed(3));
      w.classList.toggle("is-now", dist < 0.3 && whole < 0.5);
    });

    const now = clamp(Math.round(t), 0, N - 1);
    const end = t > N - 0.5;
    caps.forEach((cap, i) => cap.classList.toggle("is-now", end ? i === N : i === now));
    buttons.forEach((b, i) => {
      b.classList.toggle("is-now", !end && i === now);
      b.classList.toggle("is-past", end || i < now);
    });
  };
  const queue = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(frame);
  };

  window.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", () => {
    measure();
    queue();
  });

  /* A press on a move goes to it. */
  buttons.forEach((b, i) =>
    b.addEventListener("click", () => {
      const to = window.scrollY + rig.getBoundingClientRect().top - stick() + span() * (i / N);
      window.scrollTo({ top: to, behavior: "smooth" });
    }),
  );

  measure();
  frame();
}
