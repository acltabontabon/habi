/*
 * The film: a product ad. Type on a dark stage states the problem; the threads of Habi's mark gather; then the
 * real app, on floating glass, one beat at a time: what fits and why, the libraries of the builders, the
 * community and your team, seven agents, the Skill Studio, a pull request back; the principles; the call.
 *
 * Every picture of the app is the app (scripts/docs-screenshots.mjs photographs it). Pieces of it lift off
 * the screen as crops of the same picture. The music is cut to 120 bpm, so cuts land on the beat.
 * A frame is a pure function of time: `film.seek(t)`, so scripts/render-film.mjs can step through it.
 */
(() => {
  const W = 1440;
  const H = 900;
  const stage = document.getElementById("stage");
  const NS = "http://www.w3.org/2000/svg";

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const out = (t) => 1 - (1 - t) ** 4;
  const back = (t) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2;
  const span = (t, a, b) => clamp((t - a) / (b - a));
  /** In for a while, then out: 0 → 1 → 0. */
  const held = (t, a, b, inn = 0.45, outT = 0.35) => out(span(t, a, a + inn)) * (1 - ease(span(t, b - outT, b)));

  const el = (cls, parent, html = "") => {
    const e = document.createElement("div");
    e.className = cls;
    if (html) e.innerHTML = html;
    parent.append(e);
    return e;
  };
  const S = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.append(e);
    return e;
  };
  const place = (e, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1, o = 1, blur = 0 }) => {
    e.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, ${z.toFixed(1)}px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) rotateZ(${rz.toFixed(2)}deg) scale(${s.toFixed(4)})`;
    e.style.opacity = clamp(o).toFixed(3);
    e.style.filter = blur > 0.05 ? `blur(${blur.toFixed(1)}px)` : "none";
  };
  const kf = (keys, t) => {
    if (t <= keys[0].t) return { ...keys[0] };
    const last = keys[keys.length - 1];
    if (t >= last.t) return { ...last };
    let i = 0;
    while (keys[i + 1].t <= t) i++;
    const a = keys[i];
    const b = keys[i + 1];
    const p = ease((t - a.t) / (b.t - a.t));
    const o = {};
    for (const k in a) if (k !== "t") o[k] = lerp(a[k], b[k] ?? a[k], p);
    return o;
  };

  /* ── The stage: glows, then scenes, then grain ───────────────────────────────────────────────── */
  const glows = [
    { c: "rgba(242,165,65,.22)" },
    { c: "rgba(90,110,220,.16)" },
    { c: "rgba(60,170,170,.10)" },
  ].map((g) => {
    const e = el("glow", stage);
    e.style.background = `radial-gradient(circle, ${g.c} 0%, rgba(0,0,0,0) 62%)`;
    return e;
  });

  // The cold open runs OPEN seconds longer than the cut the rest is timed to; every scene after it plays
  // that much later (two bars, so the cuts stay on the beat).
  const OPEN = 6;
  // The share scene runs two bars longer than its cut too: what comes after it, later again.
  const LATE = OPEN + 4;
  const scenes = [];
  const scene = (a, b, build, shift = OPEN) => {
    const root = el("scene", stage);
    const world = el("world", root);
    const hud = el("hud", root);
    const s = { a, b, shift, root, ...build(world, hud) };
    scenes.push(s);
    return s;
  };

  /** A window of the app; `src` is a screenshot. */
  const win = (parent, src) => {
    const w = el("win", parent);
    const img = document.createElement("img");
    img.src = src;
    w.append(img);
    const sheen = el("sheen", w);
    return { w, sheen };
  };
  const sweep = (wn, t, a, dur = 1.6) => {
    wn.sheen.style.backgroundPosition = `${(lerp(110, -10, ease(span(t, a, a + dur)))).toFixed(1)}% 0`;
  };
  /** Frames a region of the window at the centre: where to put the window so (cx, cy) sits at (sx, sy). */
  const frame = (cx, cy, s, sx = 0, sy = 0) => ({ x: -(cx - 720) * s + sx, y: -(cy - 450) * s + sy, s });

  /** A piece of the picture, the same size as on the window it came from. */
  const crop = (parent, src, r) => {
    const c = el("crop", parent);
    c.style.width = `${r.w}px`;
    c.style.height = `${r.h}px`;
    c.style.margin = `${-r.h / 2}px 0 0 ${-r.w / 2}px`;
    c.style.backgroundImage = `url(${src})`;
    c.style.backgroundPosition = `${-r.x}px ${-r.y}px`;
    return { c, r };
  };
  /** Where a crop sits when it is exactly over its place on a window framed by `f`. */
  const over = (r, f) => ({ x: f.x + (r.x + r.w / 2 - 720) * f.s, y: f.y + (r.y + r.h / 2 - 450) * f.s, s: f.s });

  /** A line of type that rises into place. */
  const type = (parent, html, { size = 96, top = 400, left = null, cls = "" } = {}) => {
    const e = el(`type ${left !== null ? "left" : ""} ${cls}`, parent, html);
    e.style.fontSize = `${size}px`;
    e.style.top = `${top}px`;
    if (left !== null) e.style.left = `${left}px`;
    return e;
  };
  const rise = (e, t, a, b, dy = 40) => {
    const v = held(t, a, b);
    const p = out(span(t, a, a + 0.6));
    e.style.opacity = v.toFixed(3);
    e.style.transform = `translateY(${((1 - p) * dy).toFixed(1)}px)`;
    e.style.filter = p < 0.98 ? `blur(${((1 - p) * 10).toFixed(1)}px)` : "none";
  };

  const DARK = (n) => `/shots/${n}.jpg`;
  const LIGHT = (n) => `/docs-media/${n}.jpg`;

  /* ── 1 · Cold open: the problem, in type ──────────────────────────────────────────────────────── */
  scene(0, 14.2, (world, hud) => {
    const a1 = type(hud, "Your team's best skill", { size: 88, top: 330 });
    const a2 = type(hud, "<em>lives on one laptop.</em>", { size: 88, top: 424 });
    const b1 = type(hud, "Fixes never make it back.", { size: 88, top: 330 });
    const b2 = type(hud, "<em>Everyone runs an old copy.</em>", { size: 88, top: 424 });
    const l1 = type(hud, "Global, or just this repo?", { size: 88, top: 330 });
    const l2 = type(hud, "<em>Nobody can tell what fits.</em>", { size: 88, top: 424 });
    const frags = ["v2", "FINAL", "FINAL2", "old-repo", "will DM", "#engineering", "in someone's head", "404", "~/.claude/skills", "agent-skills?", "backup (copy)", "TODO: write this properly"].map((t, i) => {
      const e = el("frag", world, t);
      e.style.fontSize = `${30 + (i % 4) * 10}px`;
      return { e, i };
    });
    return {
      update(t) {
        rise(a1, t, 0.4, 4.3);
        rise(a2, t, 1.3, 4.3);
        rise(b1, t, 4.5, 8.4);
        rise(b2, t, 5.4, 8.4);
        rise(l1, t, 8.6, 12.3);
        rise(l2, t, 9.5, 12.3);
        // The places it might be, rushing past and out of frame, gone before the last line lands.
        for (const f of frags) {
          const a = (f.i / frags.length) * Math.PI * 2 + 0.4;
          const start = 12.1 + f.i * 0.08;
          const p = span(t, start, start + 1.15);
          const z = lerp(-2600, 900, p);
          const r = (260 + (f.i % 3) * 120) * lerp(1, 2.6, p * p);
          place(f.e, { x: Math.cos(a) * r - 80, y: Math.sin(a) * r * 0.62, z, s: 1, o: p > 0 && p < 1 ? Math.min(1, p * 4) * (1 - span(z, 300, 900)) : 0 });
        }
      },
    };
  }, 0);

  /* ── 2 · Reveal: threads gather into the mark ─────────────────────────────────────────────────── */
  scene(8, 12.25, (world, hud) => {
    const svg = S("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, style: "position:absolute;inset:0" }, hud);
    const defs = S("defs", {}, svg);
    const f = S("filter", { id: "bloom", x: "-50%", y: "-50%", width: "200%", height: "200%" }, defs);
    S("feGaussianBlur", { stdDeviation: "8", result: "b" }, f);
    const m = S("feMerge", {}, f);
    S("feMergeNode", { in: "b" }, m);
    S("feMergeNode", { in: "SourceGraphic" }, m);
    // Threads from everywhere, converging.
    const threads = [];
    for (let i = 0; i < 44; i++) {
      const a = (i / 44) * Math.PI * 2;
      const r = 900;
      const x0 = 720 + Math.cos(a) * r;
      const y0 = 360 + Math.sin(a) * r * 0.75;
      const p = S("path", { d: `M ${x0.toFixed(0)} ${y0.toFixed(0)} Q ${(720 + Math.cos(a + 0.6) * 220).toFixed(0)} ${(360 + Math.sin(a + 0.6) * 160).toFixed(0)} 720 360`, fill: "none", stroke: i % 5 === 0 ? "#f2a541" : "rgba(236,236,239,.55)", "stroke-width": i % 5 === 0 ? 2.2 : 1.2, pathLength: 1 }, svg);
      p.style.strokeDasharray = "1 1";
      threads.push({ p, i });
    }
    // The mark: two warps and a weft, as in design/habi-mark.svg.
    const g = S("g", { transform: "translate(720 360)", filter: "url(#bloom)" }, svg);
    const mk = (d, stroke, w) => {
      const p = S("path", { d, fill: "none", stroke, "stroke-width": w, "stroke-linecap": "round", pathLength: 1 }, g);
      p.style.strokeDasharray = "1 1";
      return p;
    };
    const left = mk("M -50 -96 L -50 96", "#ececef", 26);
    const weft = mk("M -86 2 L 86 2", "#f2a541", 26);
    const right = mk("M 50 -96 L 50 96", "#ececef", 26);
    const meet = type(hud, "Meet Habi.", { size: 110, top: 520 });
    const sub = type(hud, "The home for your team's agent skills.", { size: 34, top: 660 });
    sub.style.fontWeight = "450";
    sub.style.letterSpacing = "-0.01em";
    sub.style.color = "#b9b8c0";
    return {
      update(t) {
        for (const th of threads) {
          const a = 8.05 + (th.i % 11) * 0.06;
          const p = ease(span(t, a, a + 1.2));
          th.p.style.strokeDashoffset = (1 - p).toFixed(3);
          th.p.style.opacity = (1 - span(t, 9.4, 10.1)).toFixed(3);
        }
        left.style.strokeDashoffset = (1 - ease(span(t, 9.0, 9.6))).toFixed(3);
        right.style.strokeDashoffset = (1 - ease(span(t, 9.2, 9.8))).toFixed(3);
        weft.style.strokeDashoffset = (1 - ease(span(t, 9.5, 10.1))).toFixed(3);
        g.setAttribute("transform", `translate(720 ${lerp(450, 360, ease(span(t, 9.8, 10.4)))}) scale(${lerp(1.3, 1, ease(span(t, 9.8, 10.4))).toFixed(3)})`);
        rise(meet, t, 10.1, 12.25);
        rise(sub, t, 10.6, 12.25, 20);
      },
    };
  });

  /* ── 3 · Hero: every project, woven with every library ────────────────────────────────────────── */
  scene(12, 18.25, (world, hud) => {
    const wn = win(world, DARK("home"));
    const k = type(hud, "Habi · home", { size: 17, top: 70, cls: "kicker" });
    const l1 = type(hud, "Every project. Every library.", { size: 64, top: 96 });
    const l2 = type(hud, "<em>Woven together.</em>", { size: 64, top: 166 });
    return {
      update(t) {
        const rise3 = out(span(t, 12.0, 13.6));
        const c = kf(
          [
            { t: 12, y: 520, rx: 58, s: 0.6, ry: 0 },
            { t: 13.6, y: 130, rx: 14, s: 0.74, ry: -6 },
            { t: 18.2, y: 120, rx: 10, s: 0.79, ry: 6 },
          ],
          t,
        );
        place(wn.w, { x: 0, y: c.y, z: 0, rx: c.rx, ry: c.ry, s: c.s, o: rise3 });
        sweep(wn, t, 13.4, 2.0);
        rise(k, t, 13.6, 18.25, 10);
        rise(l1, t, 13.8, 18.25);
        rise(l2, t, 15.0, 18.25);
      },
    };
  });

  /* ── 4 · Find: the answer to “nobody can tell what fits”. Open the repo; the skill that fits, and why ──── */
  scene(18, 27.25, (world, hud) => {
    const src = DARK("project");
    const wn = win(world, src);
    const scrim = el("scrim", hud);
    const k = type(hud, "Find", { size: 17, top: 300, left: 96, cls: "kicker" });
    const l1 = type(hud, "Open billing-service.", { size: 72, top: 336, left: 96 });
    const l2 = type(hud, "<em>Habi can tell.</em>", { size: 72, top: 410, left: 96 });
    const l3 = type(hud, "It fits because", { size: 72, top: 336, left: 96 });
    const l4 = type(hud, "<em>it uses Liquibase.</em>", { size: 72, top: 410, left: 96 });
    const sub = type(hud, "pom.xml, line 31. Nothing built, nothing run.", { size: 24, top: 512, left: 98 });
    sub.style.fontWeight = "450";
    sub.style.letterSpacing = "0";
    sub.style.color = "#b9b8c0";
    const card = crop(world, src, { x: 240, y: 418, w: 400, h: 110 });
    const head = crop(world, src, { x: 664, y: 242, w: 410, h: 80 });
    const chip = crop(world, src, { x: 698, y: 788, w: 316, h: 36 });
    return {
      update(t) {
        // The window turns to face us on the project's list; then the camera crosses to the skill itself.
        const c = kf(
          [
            { t: 18.0, x: 340, y: 40, z: -200, ry: -26, rx: 6, s: 0.66 },
            { t: 20.0, ...frame(470, 420, 1.12, 300, 30), z: 0, ry: -6, rx: 2 },
            { t: 22.4, ...frame(450, 460, 1.22, 320, 34), z: 0, ry: 0, rx: 0 },
            { t: 23.6, ...frame(860, 590, 1.1, 300, 36), z: 0, ry: 0, rx: 0 },
            { t: 27.2, ...frame(860, 600, 1.14, 300, 36), z: 0, ry: 0, rx: 0 },
          ],
          t,
        );
        place(wn.w, { x: c.x, y: c.y, z: c.z, rx: c.rx, ry: c.ry, s: c.s, o: out(span(t, 18.0, 18.5)) });
        sweep(wn, t, 18.4, 2.2);
        const f = { x: c.x, y: c.y, s: c.s };
        // There it is: the card lifts off the list.
        const lift1 = held(t, 20.4, 23.4, 0.7, 0.5);
        const o1 = over(card.r, f);
        place(card.c, { x: o1.x, y: o1.y - lift1 * 24, z: lift1 * 200, s: o1.s * (1 + lift1 * 0.14), o: lift1 });
        // Whose it is, and why: the skill's title, then the receipt.
        const lift2 = held(t, 23.9, 27.25, 0.6, 0.3);
        const o2 = over(head.r, f);
        place(head.c, { x: o2.x, y: o2.y + lift2 * 34, z: lift2 * 160, s: o2.s * (1 + lift2 * 0.1), o: lift2 });
        const lift3 = held(t, 24.6, 27.25, 0.6, 0.3);
        const o3 = over(chip.r, f);
        place(chip.c, { x: o3.x, y: o3.y - lift3 * 8, z: lift3 * 220, s: o3.s * (1 + lift3 * 0.25), o: lift3 });
        scrim.style.opacity = held(t, 18.4, 27.25, 0.6, 0.3).toFixed(3);
        rise(k, t, 18.6, 23.0, 10);
        rise(l1, t, 18.8, 23.0);
        rise(l2, t, 20.4, 23.0);
        rise(l3, t, 23.4, 27.25);
        rise(l4, t, 24.0, 27.25);
        rise(sub, t, 24.8, 27.25, 10);
      },
    };
  });

  /* ── 5 · Explore: the builders, the community, your team ──────────────────────────────────────── */
  scene(27, 34.25, (world, hud) => {
    const src = DARK("explore");
    const wn = win(world, src);
    const builders = [214, 278, 343, 407, 472, 536, 601, 665].map((y, i) => crop(world, src, { x: 862, y, w: 546, h: i === 7 ? 80 : 64 }));
    const community = [403, 467, 532, 596].map((y) => crop(world, src, { x: 272, y, w: 546, h: 64 }));
    const team = [217, 282].map((y) => crop(world, src, { x: 272, y, w: 546, h: 64 }));
    const k = type(hud, "Explore", { size: 17, top: 70, cls: "kicker" });
    const l1 = type(hud, "Skills from the builders.", { size: 66, top: 96 });
    const l2 = type(hud, "<em>From the community.</em>", { size: 66, top: 96 });
    const l3 = type(hud, "And from your own team.", { size: 66, top: 96 });
    return {
      update(t) {
        const f = { x: 0, y: 70, s: 0.82 };
        place(wn.w, { x: f.x, y: f.y, rx: 8, s: f.s, o: out(span(t, 27.0, 27.4)) * (1 - 0.55 * span(t, 27.6, 28.2)), blur: span(t, 27.6, 28.2) * 3 });
        sweep(wn, t, 27.2, 1.8);
        const show = (list, a, b, dx) => list.forEach((cp, i) => {
          const o0 = over(cp.r, f);
          const p = held(t, a + i * 0.09, b, 0.55, 0.3);
          place(cp.c, { x: lerp(o0.x, o0.x + dx, p), y: o0.y, z: p * (220 - i * 8), s: o0.s * (1 + p * 0.32), rx: 8 * (1 - p), o: p });
        });
        show(builders, 27.8, 30.2, -200);
        show(community, 30.4, 32.3, 160);
        show(team, 32.4, 34.25, 160);
        rise(k, t, 27.6, 34.25, 10);
        rise(l1, t, 27.8, 30.2);
        rise(l2, t, 30.4, 32.3);
        rise(l3, t, 32.4, 34.25);
      },
    };
  });

  /* ── 6 · Install: seven agents, every file seen first ─────────────────────────────────────────── */
  scene(34, 41.25, (world, hud) => {
    const src = DARK("install-review");
    const wn = win(world, src);
    const scrim = el("scrim", hud);
    const AG = ["Claude Code", "Cursor", "Codex", "Gemini CLI", "GitHub Copilot", "OpenCode", "Junie"];
    const rows = [214, 248, 282, 316, 350, 384, 418].map((y) => crop(world, src, { x: 267, y: y - 17, w: 296, h: 35 }));
    const words = AG.map((a) => type(hud, a, { size: 88, top: 380, left: 96 }));
    const k = type(hud, "Install", { size: 17, top: 330, left: 96, cls: "kicker" });
    const files = crop(world, src, { x: 589, y: 180, w: 580, h: 224 });
    const l1 = type(hud, "Every file,", { size: 76, top: 336, left: 96 });
    const l2 = type(hud, "<em>seen first.</em>", { size: 76, top: 414, left: 96 });
    const sub = type(hud, "Your edits survive updates. Anything can be restored.", { size: 22, top: 520, left: 98 });
    sub.style.fontWeight = "450";
    sub.style.letterSpacing = "0";
    sub.style.color = "#b9b8c0";
    return {
      update(t) {
        const c = kf(
          [
            { t: 34.0, x: 380, y: 0, z: -160, ry: -20, s: 0.68 },
            { t: 35.0, x: 360, y: 0, z: 0, ry: -12, s: 0.7 },
            { t: 38.0, x: 340, y: 0, z: 0, ry: -8, s: 0.72 },
            { t: 38.8, ...frame(880, 290, 1.25, 330, 0), z: 0, ry: 0 },
            { t: 41.2, ...frame(880, 290, 1.3, 330, 0), z: 0, ry: 0 },
          ],
          t,
        );
        place(wn.w, { x: c.x, y: c.y, z: c.z, ry: c.ry, s: c.s, o: out(span(t, 34.0, 34.4)) });
        sweep(wn, t, 34.3, 2.0);
        // One agent a beat, its row lifting off the list as its name goes up.
        const beat = 0.5;
        AG.forEach((_, i) => {
          const a = 34.6 + i * beat;
          const w = words[i];
          const on = t >= a && t < a + beat ? 1 : 0;
          const p = out(span(t, a, a + 0.25));
          w.style.opacity = on ? p.toFixed(3) : "0";
          w.style.transform = `translateY(${((1 - p) * 24).toFixed(1)}px)`;
          const r = rows[i];
          const flat = c.ry < 0.5;
          const o0 = { x: c.x + (r.r.x + r.r.w / 2 - 720) * c.s * Math.cos((c.ry * Math.PI) / 180), y: c.y + (r.r.y + r.r.h / 2 - 450) * c.s, s: c.s };
          const lift = held(t, a, Math.min(a + 1.2, 38.0), 0.2, 0.3);
          place(r.c, { x: o0.x + lift * 40, y: o0.y, z: lift * 140, ry: flat ? 0 : c.ry, s: o0.s * (1 + lift * 0.15), o: lift });
        });
        scrim.style.opacity = held(t, 34.3, 41.25, 0.5, 0.3).toFixed(3);
        rise(k, t, 34.4, 38.0, 10);
        const fo = over(files.r, { x: c.x, y: c.y, s: c.s });
        const lf = held(t, 39.2, 41.25, 0.6, 0.3);
        place(files.c, { x: fo.x, y: fo.y - lf * 20, z: lf * 120, s: fo.s * (1 + lf * 0.05), o: lf });
        rise(l1, t, 38.4, 41.25);
        rise(l2, t, 38.9, 41.25);
        rise(sub, t, 39.4, 41.25, 10);
      },
    };
  });

  /* ── 7 · The Skill Studio ─────────────────────────────────────────────────────────────────────── */
  scene(41, 48.25, (world, hud) => {
    const a = win(world, DARK("my-skills"));
    const srcB = DARK("skill-studio");
    const b = win(world, srcB);
    const scrim = el("scrim", hud);
    const k = type(hud, "Write", { size: 17, top: 300, left: 96, cls: "kicker" });
    const l1 = type(hud, "Learned something?", { size: 72, top: 336, left: 96 });
    const l2 = type(hud, "<em>Write it down.</em>", { size: 72, top: 410, left: 96 });
    const l3 = type(hud, "One document.", { size: 72, top: 336, left: 96 });
    const l4 = type(hud, "<em>The whole skill.</em>", { size: 72, top: 410, left: 96 });
    const sub = type(hud, "Purpose, when it applies, the steps and the scripts.", { size: 22, top: 516, left: 98 });
    sub.style.fontWeight = "450";
    sub.style.letterSpacing = "0";
    sub.style.color = "#b9b8c0";
    const line = crop(world, srcB, { x: 470, y: 166, w: 760, h: 34 });
    return {
      update(t) {
        const ca = kf(
          [
            { t: 41.0, x: 300, y: 40, z: -120, ry: -18, s: 0.62 },
            { t: 44.4, x: 330, y: 30, z: 0, ry: -10, s: 0.66 },
          ],
          t,
        );
        place(a.w, { x: ca.x, y: ca.y, z: ca.z, ry: ca.ry, s: ca.s, o: out(span(t, 41.0, 41.4)) * (1 - span(t, 44.2, 44.6)) });
        sweep(a, t, 41.3, 2);
        const cb = kf(
          [
            { t: 44.2, ...frame(830, 230, 0.9, 470, 40), z: -120, ry: -12 },
            { t: 45.2, ...frame(830, 230, 1.05, 470, 20), z: 0, ry: 0 },
            { t: 48.2, ...frame(830, 230, 1.1, 470, 20), z: 0, ry: 0 },
          ],
          t,
        );
        place(b.w, { x: cb.x, y: cb.y, z: cb.z, ry: cb.ry, s: cb.s, o: out(span(t, 44.2, 44.7)) });
        sweep(b, t, 44.6, 1.8);
        // The description, typed: the line is uncovered left to right.
        const o = over(line.r, { x: cb.x, y: cb.y, s: cb.s });
        const tp = span(t, 45.4, 47.0);
        const lv = held(t, 45.3, 48.25, 0.2, 0.3);
        line.c.style.clipPath = `inset(0 ${((1 - tp) * 100).toFixed(1)}% 0 0)`;
        place(line.c, { x: o.x, y: o.y - lv * 14, z: lv * 90, s: o.s * (1 + lv * 0.05), o: lv });
        scrim.style.opacity = held(t, 41.3, 48.25, 0.5, 0.3).toFixed(3);
        rise(k, t, 41.4, 44.2, 10);
        rise(l1, t, 41.6, 44.2);
        rise(l2, t, 42.4, 44.2);
        rise(l3, t, 44.6, 48.25);
        rise(l4, t, 45.2, 48.25);
        rise(sub, t, 45.8, 48.25, 10);
      },
    };
  });

  /* ── 8 · Share: send it back; every project sees the update, and exactly what changed ───────────── */
  scene(48, 59.25, (world, hud) => {
    const srcA = LIGHT("share-review-status");
    const a = win(world, srcA);
    const srcB = DARK("project");
    const b = win(world, srcB);
    const scrim = el("scrim", hud);
    const k = type(hud, "Share", { size: 17, top: 300, left: 96, cls: "kicker" });
    const l1 = type(hud, "Send it back", { size: 76, top: 336, left: 96 });
    const l2 = type(hud, "<em>as a pull request.</em>", { size: 76, top: 414, left: 96 });
    const l3 = type(hud, "Reviewed. Merged.", { size: 76, top: 336, left: 96 });
    const l4 = type(hud, "<em>Every project updates.</em>", { size: 76, top: 414, left: 96 });
    const srcC = DARK("update-review");
    const c = win(world, srcC);
    const l5 = type(hud, "See what changed.", { size: 60, top: 346, left: 96 });
    const l6 = type(hud, "<em>Update when ready.</em>", { size: 60, top: 408, left: 96 });
    const sub = type(hud, "In every project, and on your machine. Your own edits kept.", { size: 20, top: 496, left: 98 });
    sub.style.fontWeight = "450";
    sub.style.letterSpacing = "0";
    sub.style.color = "#b9b8c0";
    const review = crop(world, srcA, { x: 272, y: 0, w: 1136, h: 210 });
    const update = crop(world, srcB, { x: 240, y: 418, w: 400, h: 111 });
    const head = crop(world, srcC, { x: 254, y: 208, w: 350, h: 56 });
    const line = crop(world, srcC, { x: 290, y: 468, w: 740, h: 26 });
    return {
      update(t) {
        const ca = kf(
          [
            { t: 48.0, x: 470, y: 30, z: -150, ry: -20, s: 0.56 },
            { t: 51.6, x: 450, y: 20, z: 0, ry: -9, s: 0.6 },
          ],
          t,
        );
        place(a.w, { x: ca.x, y: ca.y, z: ca.z, ry: ca.ry, s: ca.s, o: out(span(t, 48.0, 48.4)) * (1 - span(t, 51.4, 51.8)) });
        sweep(a, t, 48.3, 2);
        const lr = held(t, 49.4, 51.8, 0.6, 0.3);
        const fa = { x: ca.x, y: ca.y, s: ca.s };
        const orv = over(review.r, fa);
        place(review.c, { x: orv.x * Math.cos((ca.ry * Math.PI) / 180), y: orv.y - lr * 20, z: lr * 140, ry: ca.ry, s: orv.s * (1 + lr * 0.05), o: lr });
        const cb = kf(
          [
            { t: 51.4, ...frame(440, 470, 0.95, 330, 0), z: -120, ry: -10 },
            { t: 52.4, ...frame(440, 470, 1.2, 330, 0), z: 0, ry: 0 },
            { t: 55.2, ...frame(440, 470, 1.26, 330, 0), z: 0, ry: 0 },
          ],
          t,
        );
        place(b.w, { x: cb.x, y: cb.y, z: cb.z, ry: cb.ry, s: cb.s, o: out(span(t, 51.4, 51.9)) * (1 - span(t, 55.1, 55.5)) });
        sweep(b, t, 51.8, 1.8);
        const lu = held(t, 52.8, 55.5, 0.5, 0.3);
        const ou = over(update.r, { x: cb.x, y: cb.y, s: cb.s });
        place(update.c, { x: ou.x, y: ou.y - lu * 24, z: lu * 170, s: ou.s * (1 + lu * 0.12), o: lu });
        // The update itself: what the fix changed, line by line, before anything is written.
        const cc = kf(
          [
            { t: 55.1, ...frame(730, 440, 0.78, 360, 0), z: -160, ry: -12, rx: 4 },
            { t: 56.2, ...frame(730, 440, 0.9, 360, 0), z: 0, ry: 0, rx: 0 },
            { t: 59.2, ...frame(730, 440, 0.94, 360, 0), z: 0, ry: 0, rx: 0 },
          ],
          t,
        );
        place(c.w, { x: cc.x, y: cc.y, z: cc.z, rx: cc.rx, ry: cc.ry, s: cc.s, o: out(span(t, 55.1, 55.6)) });
        sweep(c, t, 55.4, 1.8);
        const fc = { x: cc.x, y: cc.y, s: cc.s };
        const lh = held(t, 56.0, 59.25, 0.5, 0.3);
        const oh = over(head.r, fc);
        place(head.c, { x: oh.x, y: oh.y + lh * 20, z: lh * 120, s: oh.s * (1 + lh * 0.06), o: lh });
        const ll = held(t, 56.6, 59.25, 0.6, 0.3);
        const ol = over(line.r, fc);
        place(line.c, { x: ol.x, y: ol.y - ll * 6, z: ll * 200, s: ol.s * (1 + ll * 0.16), o: ll });
        scrim.style.opacity = held(t, 48.3, 59.25, 0.5, 0.3).toFixed(3);
        rise(k, t, 48.4, 51.6, 10);
        rise(l1, t, 48.6, 51.6);
        rise(l2, t, 49.2, 51.6);
        rise(l3, t, 51.8, 55.3);
        rise(l4, t, 52.4, 55.3);
        rise(l5, t, 55.5, 59.25);
        rise(l6, t, 56.1, 59.25);
        rise(sub, t, 56.8, 59.25, 10);
      },
    };
  });

  /* ── 9 · No strings: one claim a beat ─────────────────────────────────────────────────────────── */
  scene(55, 61.25, (world, hud) => {
    const claims = ["No account.", "No telemetry.", "No model calls.", "Plain files.", "<em>Free and open source.</em>"];
    const lines = claims.map((c) => type(hud, c, { size: 128, top: 380 }));
    return {
      update(t) {
        lines.forEach((l, i) => {
          const a = 55.0 + i * 1.0;
          const b = i === lines.length - 1 ? 61.25 : a + 1.0;
          const on = t >= a && t < b;
          const p = out(span(t, a, a + 0.18));
          l.style.opacity = on ? (i === lines.length - 1 ? held(t, a, b, 0.18, 0.4) : p).toFixed(3) : "0";
          l.style.transform = `scale(${lerp(1.12, 1, p).toFixed(3)})`;
          l.style.filter = "none";
        });
      },
    };
  }, LATE);

  /* ── 10 · The end: the mark, the line, the call ───────────────────────────────────────────────── */
  scene(61, 68, (world, hud) => {
    const svg = S("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, style: "position:absolute;inset:0" }, hud);
    const g = S("g", { transform: "translate(720 300)" }, svg);
    S("rect", { x: -78, y: -78, width: 156, height: 156, rx: 36, fill: "#ececef" }, g);
    const mk = (x1, y1, x2, y2, stroke, w) => S("line", { x1, y1, x2, y2, stroke, "stroke-width": w, "stroke-linecap": "round" }, g);
    mk(-24, -42, -24, 42, "#08080a", 13);
    mk(24, -42, 24, 42, "#08080a", 13);
    mk(-38, 1, 38, 1, "#f2a541", 13);
    const name = type(hud, "habi", { size: 120, top: 420 });
    name.style.letterSpacing = "-0.07em";
    name.style.fontWeight = "700";
    const tag = type(hud, "What one developer learns, <em>every project keeps.</em>", { size: 40, top: 566 });
    tag.style.fontWeight = "550";
    tag.style.letterSpacing = "-0.02em";
    const cta = type(hud, "Download free · macOS and Windows · acltabontabon.com/habi", { size: 20, top: 660 });
    cta.style.fontFamily = '"IBM Plex Mono", monospace';
    cta.style.fontWeight = "500";
    cta.style.letterSpacing = "0.04em";
    cta.style.color = "#b9b8c0";
    return {
      update(t) {
        const p = out(span(t, 61.1, 61.9));
        g.setAttribute("transform", `translate(720 300) scale(${lerp(0.6, 1, p).toFixed(3)})`);
        g.setAttribute("opacity", p.toFixed(3));
        rise(name, t, 61.5, 70);
        rise(tag, t, 62.2, 70, 20);
        rise(cta, t, 63.0, 70, 10);
      },
    };
  }, LATE);

  const vignette = el("vignette", stage);
  const grain = el("grain", stage);
  const flash = el("flash", stage);
  void vignette;

  /* ── Time ─────────────────────────────────────────────────────────────────────────────────────── */
  const seek = (t) => {
    // The light moves, slowly.
    glows.forEach((g, i) => {
      const x = 720 + Math.cos(t * 0.13 + i * 2.1) * 420;
      const y = 450 + Math.sin(t * 0.11 + i * 1.7) * 260;
      g.style.left = `${x.toFixed(0)}px`;
      g.style.top = `${y.toFixed(0)}px`;
    });
    for (const s of scenes) {
      const lt = t - s.shift;
      const v = span(lt, s.a, s.a + 0.25) * (1 - span(lt, s.b - 0.25, s.b));
      s.root.style.opacity = v.toFixed(3);
      s.root.style.display = v > 0.001 ? "" : "none";
      if (v > 0.001) s.update(lt);
    }
    // A small flash on the cuts that hit hardest.
    let fl = 0;
    for (const c of [8 + OPEN, 12 + OPEN, 55 + LATE]) if (t >= c && t < c + 0.25) fl = Math.max(fl, (1 - (t - c) / 0.25) * 0.18);
    flash.style.opacity = fl.toFixed(3);
    const k = Math.floor(t * 8);
    grain.style.backgroundPosition = `${(k * 97) % 300}px ${(k * 61) % 300}px`;
  };

  const ready = (async () => {
    const tl = await (await fetch("/timeline.json")).json();
    await document.fonts.ready;
    // The crops are backgrounds; make sure every picture is in before the first frame.
    const srcs = [...new Set([...document.querySelectorAll(".crop")].map((c) => c.style.backgroundImage.slice(5, -2)).concat([...document.images].map((i) => i.getAttribute("src"))))];
    await Promise.all(srcs.map((src) => {
      const i = new Image();
      i.src = src;
      return i.decode().catch(() => 0);
    }));
    seek(0);
    return tl;
  })();

  window.film = {
    ready,
    seek,
    poster() {
      return ready.then((tl) => seek(tl.poster));
    },
  };
})();
