/**
 * Light/dark theme: always the system's. There is no in-app choice, so the
 * window follows the operating system's setting as it changes.
 */
export function initTheme() {
  const media =
    typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const apply = () => {
    document.documentElement.dataset.theme = media?.matches === true ? "dark" : "light";
  };
  media?.addEventListener("change", apply);
  apply();
}
