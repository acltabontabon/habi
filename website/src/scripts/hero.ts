/**
 * The hero's cloth: warp threads drawn behind the headline and, clipped to
 * the lines they pass over, in front of it — and a weft thrown beneath.
 *
 * Draw a pointer across a thread and it catches; let go (or pull too far)
 * and it rings like a string fixed at both ends, then rests. Frames run only
 * while a thread moves. With reduced motion the threads hang still.
 */

const PULL = 48; // furthest a thread follows before it slips free
const SAMPLES = 36;

type Thread = { x: number; d: number; v: number; yb: number; held: boolean };

export function cloth(root: HTMLElement, reduce: boolean) {
  const xs: number[] = JSON.parse(root.dataset.warps ?? "[]");
  const back = root.querySelector<SVGSVGElement>(".cloth-back");
  const front = root.querySelector<SVGSVGElement>(".cloth-front");
  const defs = front?.querySelector("defs");
  const weftSpace = root.querySelector<HTMLElement>("[data-weft-y]");
  if (!back || !front || !defs || !weftSpace) return;
  const backPaths = [...back.querySelectorAll<SVGPathElement>("[data-thread]")];
  const fronts = [...front.querySelectorAll<SVGGElement>("[data-front]")];
  const wefts = [...back.querySelectorAll<SVGPathElement>("[data-weft]")];
  const lines = [...root.querySelectorAll<HTMLElement>(".hero-line")];
  const threads: Thread[] = xs.map(() => ({ x: 0, d: 0, v: 0, yb: 0, held: false }));
  let W = 0;
  let H = 0;

  /** A string fixed at top and bottom, pulled sideways at yb by d. */
  const offset = (t: Thread, y: number) => {
    if (t.d === 0) return 0;
    const yb = Math.min(H - 1, Math.max(1, t.yb));
    const s = y < yb ? y / yb : (H - y) / (H - yb);
    return t.d * Math.sin((Math.PI / 2) * Math.max(0, s));
  };
  const shape = (t: Thread) => {
    if (t.d === 0) return `M${t.x.toFixed(1)} 0 L${t.x.toFixed(1)} ${H.toFixed(1)}`;
    let d = "";
    for (let k = 0; k <= SAMPLES; k++) {
      const y = (k / SAMPLES) * H;
      d += `${k ? " L" : "M"}${(t.x + offset(t, y)).toFixed(1)} ${y.toFixed(1)}`;
    }
    return d;
  };
  const draw = () => {
    threads.forEach((t, i) => {
      const d = shape(t);
      backPaths[i]?.setAttribute("d", d);
      for (const p of fronts[i]?.querySelectorAll("path") ?? []) p.setAttribute("d", d);
    });
  };

  const layout = () => {
    const r = root.getBoundingClientRect();
    W = r.width;
    H = r.height;
    for (const svg of [back, front]) {
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.removeAttribute("preserveAspectRatio");
    }
    threads.forEach((t, i) => {
      t.x = ((xs[i] ?? 0) / 100) * W;
    });
    const w = weftSpace.getBoundingClientRect();
    const weftY = w.top - r.top + w.height / 2;
    // One band per line as it is drawn: a headline line that wraps is two lines of cloth.
    const bands = lines.flatMap((l) => {
      const range = document.createRange();
      range.selectNodeContents(l);
      const rows: [number, number][] = [];
      for (const b of range.getClientRects()) {
        if (b.width === 0 || b.height === 0) continue;
        const row = rows.find(([top]) => Math.abs(top - b.top) < b.height / 2);
        if (row) row[1] = Math.max(row[1], b.bottom);
        else rows.push([b.top, b.bottom]);
      }
      return rows
        .sort((a, b) => a[0] - b[0])
        .map(([top, bottom]) => {
          const h = bottom - top;
          return [top - r.top + h * 0.12, bottom - r.top - h * 0.1] as const;
        });
    });
    // Over one line and under the next; even threads also over the weft.
    defs.innerHTML = threads
      .map((_, i) => {
        const rects = bands
          .filter((_, li) => (i + li) % 2 === 0)
          .map(([a, b]) => `<rect x="-60" y="${a.toFixed(1)}" width="${W + 120}" height="${(b - a).toFixed(1)}"/>`);
        if (i % 2 === 0) rects.push(`<rect x="-60" y="${(weftY - 12).toFixed(1)}" width="${W + 120}" height="24"/>`);
        return `<clipPath id="over-${i}" clipPathUnits="userSpaceOnUse">${rects.join("")}</clipPath>`;
      })
      .join("");
    fronts.forEach((g, i) => g.setAttribute("clip-path", `url(#over-${i})`));
    const weft = `M0 ${weftY.toFixed(1)} L${W.toFixed(1)} ${weftY.toFixed(1)}`;
    for (const p of wefts) p.setAttribute("d", weft);
    draw();
  };

  layout();
  new ResizeObserver(layout).observe(root);
  void document.fonts?.ready.then(layout);
  requestAnimationFrame(() => root.classList.add("is-woven"));
  if (reduce) return;

  // Plucking.
  let raf = 0;
  let prevX = Number.NaN;
  const step = () => {
    raf = 0;
    let moving = false;
    for (const t of threads) {
      if (t.held) {
        moving = true;
        continue;
      }
      t.v += -0.07 * t.d - 0.085 * t.v;
      t.d += t.v;
      if (Math.abs(t.d) < 0.08 && Math.abs(t.v) < 0.08) {
        t.d = 0;
        t.v = 0;
      } else moving = true;
    }
    draw();
    if (moving) raf = requestAnimationFrame(step);
  };
  const kick = () => {
    if (!raf) raf = requestAnimationFrame(step);
  };
  root.addEventListener("pointermove", (e) => {
    const r = root.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    for (const t of threads) {
      if (t.held) {
        const pull = x - t.x;
        t.yb = y;
        if (Math.abs(pull) > PULL) {
          t.held = false;
          t.d = Math.sign(pull) * PULL;
          t.v = 0;
        } else t.d = pull;
        continue;
      }
      const at = t.x + offset(t, y);
      if (!Number.isNaN(prevX) && (prevX - at) * (x - at) <= 0 && Math.abs(x - prevX) < 160) {
        t.held = true;
        t.yb = y;
        t.d = x - t.x;
        t.v = 0;
        root.classList.add("is-plucked");
      }
    }
    prevX = x;
    kick();
  });
  const letGo = () => {
    for (const t of threads) t.held = false;
    prevX = Number.NaN;
    kick();
  };
  root.addEventListener("pointerleave", letGo);
  root.addEventListener("pointercancel", letGo);
}
