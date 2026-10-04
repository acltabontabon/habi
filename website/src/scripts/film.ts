/**
 * The film, in its cinema: a dialog over the page. Anything marked
 * data-film-open (a frame of the filmstrip, "Watch the film") opens it at its
 * data-at second and plays with sound, since a press lets the browser allow
 * that; /#demo opens it too, muted, as nobody pressed anything. Closing it
 * (the button, Escape, a press outside the screen) stops the film. The thread
 * under it shows where we are and can be dragged. Without scripts those links
 * simply open the video file.
 */

const MUTE = "M2.5 6.5h2.5L8.5 3.5v9L5 9.5H2.5zM10.8 6l3.4 4M14.2 6l-3.4 4";
const VOLUME = "M2.5 6.5h2.5L8.5 3.5v9L5 9.5H2.5zM10.8 5.2a4 4 0 010 5.6M12.6 3.6a6.4 6.4 0 010 8.8";

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function film(root: HTMLDialogElement) {
  const video = root.querySelector<HTMLVideoElement>("[data-film]");
  const frame = root.querySelector<HTMLElement>("[data-film-frame]");
  const seek = root.querySelector<HTMLElement>("[data-film-seek]");
  const time = root.querySelector<HTMLElement>("[data-film-time]");
  const toggle = root.querySelector<HTMLButtonElement>("[data-film-toggle]");
  const screen = root.querySelector<HTMLElement>(".film-screen");
  const sound = root.querySelector<HTMLButtonElement>("[data-film-sound]");
  if (!video || !frame || !seek || !screen) return;

  const total = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Number(seek.getAttribute("aria-valuemax")));

  const paint = () => {
    const t = video.currentTime;
    const d = total();
    seek.style.setProperty("--p", (d ? Math.min(1, t / d) : 0).toFixed(4));
    seek.setAttribute("aria-valuenow", String(Math.round(t)));
    seek.setAttribute("aria-valuetext", `${clock(t)} of ${clock(d)}`);
    if (time) time.textContent = clock(t);
  };

  const state = () => {
    frame.classList.toggle("is-playing", !video.paused);
    toggle?.setAttribute("aria-label", video.paused ? "Play the film" : "Pause the film");
  };

  const play = () => {
    video.preload = "auto";
    void video.play().catch(() => state());
  };

  const flip = () => {
    if (video.paused) play();
    else video.pause();
  };
  screen.addEventListener("click", (e) => {
    if ((e.target as Element).closest("[data-film-sound]")) return;
    if ((e.target as Element).closest("[data-film-toggle]") || e.target === screen || e.target === video) flip();
  });
  toggle?.addEventListener("click", (e) => e.stopPropagation());
  toggle?.addEventListener("click", flip);

  const voice = () => {
    if (!sound) return;
    sound.setAttribute("aria-pressed", String(!video.muted));
    sound.classList.toggle("is-on", !video.muted);
    const label = sound.querySelector("span");
    if (label) label.textContent = video.muted ? "Sound off" : "Sound on";
    const path = sound.querySelector("path");
    if (path) path.setAttribute("d", video.muted ? MUTE : VOLUME);
  };
  sound?.addEventListener("click", (e) => {
    e.stopPropagation();
    video.muted = !video.muted;
    voice();
    if (!video.muted && video.paused) play();
  });
  video.addEventListener("volumechange", voice);

  video.addEventListener("play", state);
  video.addEventListener("pause", state);
  video.addEventListener("timeupdate", paint);
  video.addEventListener("loadedmetadata", paint);

  /* The thread: press or drag to scrub, arrows to step. */
  const scrub = (clientX: number) => {
    const r = seek.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - r.left - 16) / (r.width - 32)));
    video.currentTime = p * total();
    paint();
  };
  seek.addEventListener("pointerdown", (e) => {
    seek.setPointerCapture(e.pointerId);
    scrub(e.clientX);
    const move = (m: PointerEvent) => scrub(m.clientX);
    const up = () => {
      seek.removeEventListener("pointermove", move);
      seek.removeEventListener("pointerup", up);
    };
    seek.addEventListener("pointermove", move);
    seek.addEventListener("pointerup", up);
  });
  seek.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" ? 5 : e.key === "ArrowLeft" ? -5 : 0;
    if (!d) return;
    e.preventDefault();
    video.currentTime = Math.max(0, Math.min(total(), video.currentTime + d));
    paint();
  });

  /* The cinema: opened at a chapter, closed by the button, Escape or a press outside the screen. */
  const open = (at: number, withSound: boolean) => {
    if (!root.open) root.showModal();
    video.preload = "auto";
    video.currentTime = at;
    video.muted = !withSound;
    voice();
    play();
  };
  root.addEventListener("close", () => video.pause());
  root.querySelector("[data-film-close]")?.addEventListener("click", () => root.close());
  root.addEventListener("click", (e) => {
    if (e.target === root) root.close();
  });
  document.addEventListener("click", (e) => {
    const link = (e.target as Element).closest<HTMLElement>("[data-film-open]");
    if (!link || e.defaultPrevented || link.dataset.dragged) return;
    e.preventDefault();
    open(Number(link.dataset.at ?? 0), true);
  });
  if (location.hash === "#demo") open(0, false);

  state();
  paint();
}
