/**
 * The hero's film, a backdrop, the way a streaming service does it: the still
 * is the page; a moment after it is ready the film fades in behind the words,
 * muted, from its very beginning, and plays once. It pauses
 * when scrolled away from, and when it ends the still comes back. Nothing
 * depends on it. The sound button starts the whole film again, with the music;
 * the other goes full screen. With reduced motion or data saver nothing
 * starts by itself.
 *
 * While the film is on its way (or stalls) the Habi mark is drawn over the still:
 * its saffron weft is as long as what has really arrived (the seconds of film
 * buffered ahead of where it starts), and is drawn and withdrawn until the first
 * of it comes. CSS keeps it hidden for the first moment, so a fast
 * connection never sees it.
 */

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

const MUTE = "M2.5 6.5h2.5L8.5 3.5v9L5 9.5H2.5zM10.8 6l3.4 4M14.2 6l-3.4 4";
const VOLUME = "M2.5 6.5h2.5L8.5 3.5v9L5 9.5H2.5zM10.8 5.2a4 4 0 010 5.6M12.6 3.6a6.4 6.4 0 010 8.8";
const REPLAY = "M12.5 6.5A4.6 4.6 0 004 5.2M3.5 9.5A4.6 4.6 0 0012 10.8M4 2.8v2.6h2.6M12 13.2v-2.6H9.4";

const START = 0; // the film plays from its very beginning
const DELAY = 2200; // ms the still is left alone before the film comes in
const NEED = 5; // seconds of film loaded past where it starts before it plays; the loom fills toward this

export function hero(root: HTMLElement, reduce: boolean) {
  const video = root.querySelector<HTMLVideoElement>("[data-hero-video]");
  const sound = root.querySelector<HTMLButtonElement>("[data-hero-sound]");
  const full = root.querySelector<HTMLButtonElement>("[data-hero-full]");
  if (!video) return;

  const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  // The film is a backdrop: it does not start by itself where it would cost the visitor, or fight the page for a slow line.
  const auto = !reduce && !conn?.saveData && !/^(slow-2g|2g|3g)$/.test(conn?.effectiveType ?? "");

  let started = false;
  let ended = false;
  let shown = true;

  /** The sound button says what it will do. */
  const voice = () => {
    if (!sound) return;
    sound.querySelector("path")?.setAttribute("d", ended ? REPLAY : video.muted ? MUTE : VOLUME);
    sound.classList.toggle("is-on", !video.muted && !ended);
    sound.setAttribute("aria-label", ended ? "Play the film again" : video.muted ? "Play the film with sound" : "Mute the film");
  };
  video.addEventListener("volumechange", voice);

  /* ---------- Loading ---------- */
  let at = START;
  let warm = false;

  /** Seconds of film loaded from where it is to be, or is, playing. */
  const ahead = () => {
    const t = video.currentTime;
    const b = video.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= t + 0.25 && b.end(i) >= t) return b.end(i) - t;
    }
    return 0;
  };
  const weave = () => {
    const k = clamp(ahead() / NEED);
    root.style.setProperty("--k", k.toFixed(3));
    root.classList.toggle("is-idle", k === 0);
  };
  for (const ev of ["progress", "loadeddata", "canplay", "seeked", "timeupdate"]) video.addEventListener(ev, weave);

  /** Asks for the film, and shows the loom until it plays. */
  const fetchFilm = () => {
    root.classList.add("is-loading");
    if (warm) return;
    warm = true;
    video.preload = "auto";
    video.load();
    weave();
  };
  video.addEventListener("loadedmetadata", () => {
    video.currentTime = at;
  });
  video.addEventListener("waiting", () => {
    root.classList.add("is-loading");
    weave();
  });
  video.addEventListener("playing", () => root.classList.remove("is-loading"));

  /* ---------- Starting, pausing, ending ---------- */
  const play = () => {
    video.preload = "auto";
    void video.play().catch(() => {});
  };

  const begin = (from: number, withSound: boolean) => {
    started = true;
    ended = false;
    at = from;
    root.classList.remove("is-ended");
    video.muted = !withSound;
    fetchFilm();
    if (video.readyState >= 1) video.currentTime = from;
    play();
    voice();
  };

  video.addEventListener("playing", () => root.classList.add("is-playing"));
  video.addEventListener("ended", () => {
    ended = true;
    root.classList.remove("is-playing");
    root.classList.add("is-ended");
    voice();
  });

  const settle = () => {
    if (!started || ended) return;
    if (shown && !document.hidden) play();
    else video.pause();
  };
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(
      ([e]) => {
        shown = Boolean(e?.isIntersecting);
        settle();
      },
      { threshold: 0.1 },
    ).observe(root);
  }
  document.addEventListener("visibilitychange", settle);

  // The film is asked for as soon as the page is ready, and a beat later the still gives way.
  if (auto) {
    const arrive = () => {
      fetchFilm();
      window.setTimeout(() => {
        if (shown && !document.hidden) {
          begin(START, false);
        } else {
          // Out of view already: ready where it will start, for when it comes back.
          started = true;
        }
      }, DELAY);
    };
    if (document.readyState === "complete") arrive();
    else window.addEventListener("load", arrive, { once: true });
  }

  /* ---------- The two buttons ---------- */
  sound?.addEventListener("click", () => {
    if (!started || ended || video.muted) {
      // With sound, the film again from its beginning.
      begin(0, true);
    } else {
      video.muted = true;
    }
    voice();
  });

  full?.addEventListener("click", () => {
    if (!started || ended) begin(0, true);
    const v = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    if (video.requestFullscreen) void video.requestFullscreen().catch(() => v.webkitEnterFullscreen?.());
    else v.webkitEnterFullscreen?.();
  });
  document.addEventListener("fullscreenchange", () => {
    video.controls = document.fullscreenElement === video;
  });

  root.classList.add("is-live");
  voice();
}
