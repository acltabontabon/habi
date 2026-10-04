#!/usr/bin/env node
// The film's music: an original score, synthesized here from sine waves and noise, so there is nothing to
// license and nothing to download. It is cut to scripts/film/timeline.json at 120 bpm: the cuts of the film
// land on its downbeats.
//
//   node scripts/film/score.mjs        # writes scripts/film/score.wav (render-film.mjs muxes it in)
//
// D minor. A dark intro under the type, a riser into the reveal, then a four-on-the-floor groove under the
// app (kick, clap, hats, a bass and a pad that duck under the kick, a plucked arpeggio), a whoosh on every
// cut, a breakdown of stabs for the principles, and a last chord on the mark. No dependency.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const timeline = JSON.parse(readFileSync(join(here, "timeline.json"), "utf8"));
const RATE = 44100;
const total = Math.ceil((timeline.duration + 0.5) * RATE);
const BEAT = 60 / (timeline.bpm ?? 120);
const BAR = BEAT * 4;

// Two buses: the music that ducks under the kick, and everything else.
const L = new Float32Array(total);
const R = new Float32Array(total);
const dL = new Float32Array(total);
const dR = new Float32Array(total);
const wetL = new Float32Array(total);
const wetR = new Float32Array(total);

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

function put(i, v, pan, wet, duck = false) {
  if (i < 0 || i >= total) return;
  const l = v * Math.cos(((pan + 1) * Math.PI) / 4);
  const r = v * Math.sin(((pan + 1) * Math.PI) / 4);
  if (duck) {
    dL[i] += l;
    dR[i] += r;
  } else {
    L[i] += l;
    R[i] += r;
  }
  wetL[i] += l * wet;
  wetR[i] += r * wet;
}

let seed = 7;
const noise = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2147483648 - 1;
};

/* ── Instruments ───────────────────────────────────────────────────────────────────────────────── */

/** A soft, wide pad: detuned sines and a quiet octave, slow in and out. Ducks under the kick. */
function pad(midi, t0, dur, gain, pan = 0) {
  const f = hz(midi);
  const n = Math.floor(dur * RATE);
  const i0 = Math.floor(t0 * RATE);
  const att = Math.min(1.2, dur * 0.35);
  const rel = Math.min(1.6, dur * 0.4);
  for (let k = 0; k < n; k++) {
    const t = k / RATE;
    const env = clamp(t / att) * clamp((dur - t) / rel);
    const e = env * env * (3 - 2 * env);
    const v = Math.sin(2 * Math.PI * f * 0.997 * t) + Math.sin(2 * Math.PI * f * 1.003 * t) + 0.3 * Math.sin(2 * Math.PI * f * 2 * t) + 0.12 * Math.sin(2 * Math.PI * f * 3 * t);
    put(i0 + k, v * e * gain * 0.35, pan, 0.5, true);
  }
}

/** A plucked note: a sine and two harmonics that fade faster the higher they are. */
function pluck(midi, t0, gain, pan = 0, decay = 0.35) {
  const f = hz(midi);
  const n = Math.floor(decay * 5 * RATE);
  const i0 = Math.floor(t0 * RATE);
  for (let k = 0; k < n; k++) {
    const t = k / RATE;
    const v = Math.sin(2 * Math.PI * f * t) * Math.exp(-t / decay) + 0.4 * Math.sin(2 * Math.PI * f * 2 * t) * Math.exp(-t / (decay * 0.5)) + 0.15 * Math.sin(2 * Math.PI * f * 3.01 * t) * Math.exp(-t / (decay * 0.25));
    put(i0 + k, v * Math.min(1, t / 0.003) * gain, pan, 0.35);
  }
}

/** A bell: frequency modulation and a long tail. */
function bell(midi, t0, gain, pan = 0, decay = 1.6) {
  const f = hz(midi);
  const n = Math.floor(decay * 4 * RATE);
  const i0 = Math.floor(t0 * RATE);
  for (let k = 0; k < n; k++) {
    const t = k / RATE;
    const idx = 2.2 * Math.exp(-t / 0.4);
    const v = Math.sin(2 * Math.PI * f * t + idx * Math.sin(2 * Math.PI * f * 3.5 * t)) * Math.exp(-t / decay);
    put(i0 + k, v * Math.min(1, t / 0.003) * gain, pan, 0.6);
  }
}

/** The kick: a sine that drops from a click to a thump. */
function kick(t0, gain = 0.9) {
  const n = Math.floor(0.45 * RATE);
  const i0 = Math.floor(t0 * RATE);
  let ph = 0;
  for (let k = 0; k < n; k++) {
    const t = k / RATE;
    ph += (2 * Math.PI * (48 + 110 * Math.exp(-t * 32))) / RATE;
    const v = Math.tanh(Math.sin(ph) * 1.6) * Math.exp(-t / 0.14) * Math.min(1, t / 0.0015);
    put(i0 + k, v * gain, 0, 0.05);
  }
}

/** A clap: three quick bursts of filtered noise, then a short tail. */
function clap(t0, gain = 0.22) {
  const n = Math.floor(0.25 * RATE);
  const i0 = Math.floor(t0 * RATE);
  let lp = 0;
  let hp = 0;
  for (let k = 0; k < n; k++) {
    const t = k / RATE;
    const x = noise();
    lp += 0.45 * (x - lp);
    hp += 0.08 * (lp - hp);
    const b = lp - hp;
    const env = (t < 0.03 ? (Math.floor(t / 0.01) % 2 === 0 ? 1 : 0.4) : 1) * Math.exp(-t / 0.07);
    put(i0 + k, b * env * gain * 2.2, 0, 0.45);
  }
}

/** A hat: a few milliseconds of bright noise. */
function hat(t0, gain = 0.05, open = false, pan = 0.25) {
  const n = Math.floor((open ? 0.18 : 0.04) * RATE);
  const i0 = Math.floor(t0 * RATE);
  let prev = 0;
  for (let k = 0; k < n; k++) {
    const x = noise();
    const v = x - prev;
    prev = x;
    put(i0 + k, v * Math.exp(-k / (RATE * (open ? 0.06 : 0.012))) * gain, pan, 0.15);
  }
}

/** The bass: a round sine with a little grit. Ducks under the kick. */
function bass(midi, t0, dur, gain = 0.22) {
  const f = hz(midi);
  const n = Math.floor(dur * RATE);
  const i0 = Math.floor(t0 * RATE);
  for (let k = 0; k < n; k++) {
    const t = k / RATE;
    const env = Math.min(1, t / 0.01) * clamp((dur - t) / 0.05);
    const v = Math.tanh((Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t)) * 1.3);
    put(i0 + k, v * env * gain, 0, 0.02, true);
  }
}

/** A stab: a short, bright chord. */
function stab(notes, t0, gain = 0.1) {
  for (const [i, m] of notes.entries()) {
    const f = hz(m);
    const n = Math.floor(0.9 * RATE);
    const i0 = Math.floor(t0 * RATE);
    for (let k = 0; k < n; k++) {
      const t = k / RATE;
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * t * (1 + (h % 2 ? 0.002 : -0.002))) / h;
      put(i0 + k, v * Math.exp(-t / 0.22) * Math.min(1, t / 0.004) * gain * 0.6, (i - 1.5) * 0.3, 0.55);
    }
  }
}

/** A breath of filtered noise whose band moves: the sound of a cut. */
function whoosh(t0, dur, gain, from = 400, to = 4000, pan = 0) {
  const n = Math.floor(dur * RATE);
  const i0 = Math.floor(t0 * RATE);
  let lp = 0;
  let hp = 0;
  for (let k = 0; k < n; k++) {
    const p = k / n;
    const fc = from * (to / from) ** p;
    const a = 1 - Math.exp((-2 * Math.PI * fc) / RATE);
    lp += a * (noise() - lp);
    hp += 0.02 * (lp - hp);
    const env = Math.sin(Math.PI * p) ** 1.5;
    put(i0 + k, (lp - hp) * env * gain, pan * (1 - 2 * p), 0.5);
  }
}

/** A riser: noise that swells and climbs, into a downbeat. */
function riser(tEnd, dur, gain = 0.12) {
  const n = Math.floor(dur * RATE);
  const i0 = Math.floor((tEnd - dur) * RATE);
  let lp = 0;
  for (let k = 0; k < n; k++) {
    const p = k / n;
    const fc = 300 * (9000 / 300) ** p;
    const a = 1 - Math.exp((-2 * Math.PI * fc) / RATE);
    lp += a * (noise() - lp);
    put(i0 + k, lp * p ** 2.2 * gain, Math.sin(p * 12) * 0.3, 0.6);
  }
}

/** A sub drop: a deep sine that falls. */
function drop(t0, gain = 0.6) {
  const n = Math.floor(1.6 * RATE);
  const i0 = Math.floor(t0 * RATE);
  let ph = 0;
  for (let k = 0; k < n; k++) {
    const t = k / RATE;
    ph += (2 * Math.PI * (70 * Math.exp(-t * 0.9) + 28)) / RATE;
    put(i0 + k, Math.sin(ph) * Math.exp(-t / 0.7) * Math.min(1, t / 0.005) * gain, 0, 0.2);
  }
}

/** The clock, under the cold open. */
function tick(t0, gain = 0.05, pan = -0.4) {
  const n = Math.floor(0.012 * RATE);
  const i0 = Math.floor(t0 * RATE);
  let prev = 0;
  for (let k = 0; k < n; k++) {
    const x = noise();
    put(i0 + k, (x - prev) * Math.exp(-k / (RATE * 0.003)) * gain, pan, 0.2);
    prev = x;
  }
}

/* ── The score ─────────────────────────────────────────────────────────────────────────────────── */

const at = (id) => timeline.scenes.find((s) => s.id === id).start;
const T_REVEAL = at("reveal");
const T_GROOVE = at("hero");
const T_NEVER = at("never");
const T_END = at("end");

// Chords: D minor, B flat, F, C (i, VI, III, VII), two bars each.
const CHORDS = [
  [50, 57, 62, 65, 69], // Dm
  [46, 53, 58, 62, 65], // Bb
  [41, 53, 57, 60, 65], // F
  [48, 55, 60, 64, 67], // C
];
const ROOTS = [38, 34, 41, 36];
const chordAt = (t) => Math.floor(Math.max(0, t - T_GROOVE) / (BAR * 2)) % 4;

// The hand-placed hits below are written against the reveal: everything after the cold open moves with it.
const AFTER = T_REVEAL - 8;

// Cold open: a low drone, a clock, a bell under each of the three lines, the copies flying past over a drop,
// a riser into the reveal.
pad(38, 0, T_REVEAL + 0.4, 0.8, -0.2);
pad(45, 0.5, T_REVEAL - 0.1, 0.5, 0.2);
pad(53, 4.6, T_REVEAL - 4.4, 0.35, 0.3);
pad(57, 5.4, 6.4, 0.25, -0.3);
for (let t = 0.5; t < 12.0; t += BEAT) tick(t, 0.035 + 0.025 * (t / 12));
bell(69, 1.3, 0.035, -0.3, 2.0);
bell(69, 5.4, 0.035, 0.3, 2.0);
bell(67, 9.5, 0.035, -0.1, 2.0);
for (let i = 0; i < 12; i++) whoosh(12.4 + i * 0.08, 0.5, 0.05, 900, 3000, (i % 2 ? 1 : -1) * 0.7);
drop(12.2, 0.55);
bell(62, 12.22, 0.05, 0, 2.4);
riser(T_REVEAL, 2.2, 0.14);
for (let i = 0; i < 8; i++) clap(T_REVEAL - 1.0 + i * 0.125, 0.05 + i * 0.012);

// The reveal: a hit, the mark's chime, a pad; half-time until the groove.
kick(T_REVEAL, 1.0);
stab([50, 57, 62, 69], T_REVEAL, 0.12);
bell(74, T_REVEAL + 1.0, 0.07, -0.3, 2.4);
bell(81, T_REVEAL + 1.25, 0.06, 0.3, 2.4);
bell(86, T_REVEAL + 1.5, 0.05, 0, 2.6);
pad(50, T_REVEAL, T_GROOVE - T_REVEAL + 0.6, 0.7, -0.2);
pad(57, T_REVEAL, T_GROOVE - T_REVEAL + 0.6, 0.55, 0.2);
pad(65, T_REVEAL + 1.0, T_GROOVE - T_REVEAL - 0.4, 0.4, 0);
kick(T_REVEAL + BEAT * 4, 0.7);
for (let i = 0; i < 8; i++) pluck([62, 65, 69, 72][i % 4] + 12, T_REVEAL + 2 + i * BEAT * 0.5, 0.03 + i * 0.004, i % 2 ? 0.4 : -0.4, 0.25);
riser(T_GROOVE, 1.4, 0.1);

// The groove, under the app.
for (let t = T_GROOVE; t < T_NEVER - 0.01; t += BEAT) {
  const beat = Math.round((t - T_GROOVE) / BEAT);
  kick(t, 0.85);
  if (beat % 2 === 1) clap(t, 0.2);
  hat(t + BEAT / 2, 0.06, beat % 4 === 3);
  hat(t + BEAT / 4, 0.025, false, -0.2);
  hat(t + (BEAT * 3) / 4, 0.025, false, -0.2);
}
for (let t = T_GROOVE; t < T_NEVER - 0.01; t += BAR * 2) {
  const c = chordAt(t + 0.01);
  CHORDS[c].forEach((m, i) => pad(m, t, BAR * 2 + 0.3, 0.75 - i * 0.08, (i % 2 ? 1 : -1) * 0.3));
  // A bass line: the root on the beat, an octave jump at the end of each bar.
  for (let b = 0; b < 8; b++) {
    const bt = t + b * BEAT;
    if (bt >= T_NEVER) break;
    bass(ROOTS[c] + (b % 4 === 3 ? 12 : 0), bt + 0.02, BEAT * 0.8, 0.2);
  }
}
// A plucked arpeggio in eighths, quiet, following the chords.
const ARP = [0, 2, 3, 4, 3, 2, 4, 1];
for (let t = T_GROOVE + BAR * 2, s = 0; t < T_NEVER - 0.01; t += BEAT / 2, s++) {
  const notes = CHORDS[chordAt(t)];
  pluck(notes[ARP[s % ARP.length]] + 12, t, 0.03 + (s % 4 === 0 ? 0.015 : 0), ((s % 6) - 2.5) * 0.25, 0.2);
}

// A whoosh and a crash on each cut.
for (const id of ["hero", "find", "explore", "install", "studio", "share"]) {
  const t = at(id);
  whoosh(t - 0.35, 0.6, 0.1, 500, 6000, 0.5);
  hat(t, 0.08, true, 0);
}
// Things lifting off the screen shimmer.
for (const t of [23.0, 24.2, 27.8, 30.4, 32.4, 39.2, 45.3, 49.4, 52.8]) bell(86 + (Math.round(t * 3) % 3) * 3, t + AFTER, 0.035, 0.3, 1.2);
// Seven agents, one a beat.
[74, 77, 81, 79, 84, 81, 86].forEach((m, i) => pluck(m, 34.6 + AFTER + i * 0.5, 0.06, i % 2 ? 0.5 : -0.5, 0.3));

// The principles: a stab for each claim, nothing under it but a low pad.
riser(T_NEVER, 1.2, 0.08);
pad(38, T_NEVER, T_END - T_NEVER + 0.4, 0.7, 0);
[0, 1, 2, 3, 4].forEach((i) => {
  const t = T_NEVER + i;
  kick(t, 0.9);
  stab(i === 4 ? [53, 57, 60, 65] : [50, 57, 62, 65], t, 0.11);
  whoosh(t - 0.25, 0.3, 0.05, 2000, 6000);
});

// The end: the mark, a last chord (F, add nine), a chime.
riser(T_END, 0.9, 0.06);
kick(T_END + 0.1, 0.8);
[41, 48, 53, 57, 60, 67].forEach((m, i) => pad(m, T_END + 0.1, timeline.duration - T_END + 0.3, 0.5 - i * 0.05, (i % 2 ? 1 : -1) * 0.35));
bell(77, T_END + 0.15, 0.08, 0, 3.4);
bell(84, T_END + 0.6, 0.06, 0.3, 3.4);
bell(89, T_END + 1.3, 0.05, -0.3, 3.6);

/* ── Mix: the ducked bus pumps under the kick; a reverb on what was sent wet ───────────────────── */

function reverb(input, delays, g) {
  const o = new Float32Array(total);
  for (const d of delays) {
    const buf = new Float32Array(d);
    let p = 0;
    let lp = 0;
    for (let i = 0; i < total; i++) {
      const y = buf[p];
      lp += 0.35 * (y - lp);
      buf[p] = input[i] + lp * g;
      o[i] += y * 0.25;
      p = (p + 1) % d;
    }
  }
  for (const d of [225, 556]) {
    const buf = new Float32Array(d);
    let p = 0;
    for (let i = 0; i < total; i++) {
      const y = buf[p];
      const x = o[i];
      buf[p] = x + y * 0.5;
      o[i] = y - x * 0.5;
      p = (p + 1) % d;
    }
  }
  return o;
}
const rl = reverb(wetL, [1687, 1931, 2203, 2467], 0.84);
const rr = reverb(wetR, [1721, 1993, 2251, 2503], 0.84);

const pump = (i) => {
  const t = i / RATE;
  if (t < T_GROOVE || t >= T_NEVER) return 1;
  const ph = (t - T_GROOVE) % BEAT;
  return 1 - 0.55 * Math.exp(-ph / 0.11);
};

let peak = 0;
for (let i = 0; i < total; i++) {
  const p = pump(i);
  L[i] += dL[i] * p + rl[i] * 0.8;
  R[i] += dR[i] * p + rr[i] * 0.8;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const norm = 0.92 / peak;
const pcm = Buffer.alloc(44 + total * 4);
pcm.write("RIFF", 0);
pcm.writeUInt32LE(36 + total * 4, 4);
pcm.write("WAVEfmt ", 8);
pcm.writeUInt32LE(16, 16);
pcm.writeUInt16LE(1, 20);
pcm.writeUInt16LE(2, 22);
pcm.writeUInt32LE(RATE, 24);
pcm.writeUInt32LE(RATE * 4, 28);
pcm.writeUInt16LE(4, 32);
pcm.writeUInt16LE(16, 34);
pcm.write("data", 36);
pcm.writeUInt32LE(total * 4, 40);
const fadeIn = 0.3 * RATE;
const fadeOut = 2.2 * RATE;
for (let i = 0; i < total; i++) {
  const g = norm * 1.35 * clamp(i / fadeIn) * clamp((total - i) / fadeOut);
  pcm.writeInt16LE(Math.round(Math.tanh(L[i] * g) * 31000), 44 + i * 4);
  pcm.writeInt16LE(Math.round(Math.tanh(R[i] * g) * 31000), 46 + i * 4);
}
writeFileSync(join(here, "score.wav"), pcm);
console.log(`scripts/film/score.wav  ${(total / RATE).toFixed(1)}s`);
