/**
 * Download. Without scripts the header's link opens the latest release's page, which is
 * a fine place to land. With them it opens a small chooser (the dialog in
 * components/Header.astro): macOS or Windows, the one the visitor is on marked, each
 * going straight to its installer with the version and size read from the release.
 * Any failure (offline, rate-limited, no release yet) leaves the tiles as they were,
 * pointing at the release page.
 *
 * It starts itself, so every page with the header has it.
 */
const API = "https://api.github.com/repos/acltabontabon/habi/releases/latest";
const CACHE = "habi-latest-release";

type Asset = { name: string; browser_download_url: string; size: number };
type Release = { tag_name: string; assets: Asset[] };
type OS = "macOS" | "Windows";

/** The visitor's system, or "" when it is neither macOS nor Windows (phones, Linux). */
function system(): OS | "" {
  const hints = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  const text = `${hints ?? ""} ${navigator.userAgent}`;
  if (/iPhone|iPad|Android|Linux|CrOS/i.test(text)) return "";
  if (/Mac/i.test(text)) return "macOS";
  if (/Win/i.test(text)) return "Windows";
  return "";
}

/** The one installer a system should get: the universal disk image, or the 64-bit Windows setup. */
function installer(release: Release, os: OS): Asset | undefined {
  const wanted = os === "macOS" ? /\.dmg$/ : /-setup\.exe$/;
  return release.assets.find((a) => wanted.test(a.name));
}

async function latest(): Promise<Release | null> {
  try {
    const kept = sessionStorage.getItem(CACHE);
    if (kept) return JSON.parse(kept) as Release;
  } catch {
    /* storage can be off; ask again */
  }
  const response = await fetch(API, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) return null;
  const release = (await response.json()) as Release;
  try {
    sessionStorage.setItem(CACHE, JSON.stringify(release));
  } catch {
    /* not worth failing for */
  }
  return release;
}

const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1048576))} MB`;

function start() {
  const dialog = document.querySelector<HTMLDialogElement>("dialog[data-get]");
  const triggers = document.querySelectorAll<HTMLAnchorElement>("a[data-download]");
  if (!dialog || !triggers.length) return;

  const tiles = [...dialog.querySelectorAll<HTMLAnchorElement>("[data-get-os]")];
  const os = system();
  for (const tile of tiles) tile.classList.toggle("is-yours", tile.dataset.getOs === os);

  /* A press on Download opens the chooser; a new tab, a copy or the keyboard's other ways still get the link. */
  let opener: HTMLElement | null = null;
  for (const trigger of triggers) {
    trigger.addEventListener("click", (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      opener = trigger;
      dialog.showModal();
      (dialog.querySelector<HTMLElement>(".is-yours") ?? tiles[0])?.focus();
    });
  }
  dialog.querySelector("[data-get-close]")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // a press on the dimmed page
  });
  dialog.addEventListener("close", () => opener?.focus());
  for (const tile of tiles) tile.addEventListener("click", () => window.setTimeout(() => dialog.close(), 600));

  /* The real installers, with their sizes. */
  void (async () => {
    try {
      const release = await latest();
      if (!release) return;
      const version = dialog.querySelector<HTMLElement>("[data-get-version]");
      if (version) version.textContent = `· v${release.tag_name.replace(/^v/, "")}`;
      for (const tile of tiles) {
        const asset = installer(release, tile.dataset.getOs as OS);
        if (!asset) continue;
        tile.href = asset.browser_download_url;
        const file = tile.querySelector<HTMLElement>("[data-get-file]");
        if (file) file.textContent = `${asset.name.split(".").pop() === "dmg" ? ".dmg" : ".exe"} · ${megabytes(asset.size)}`;
      }
      // The header's own link goes straight to this system's installer too, for a new tab or a copied link.
      const mine = os ? installer(release, os) : undefined;
      if (mine) for (const trigger of triggers) trigger.href = mine.browser_download_url;
    } catch {
      /* the tiles still open the release page */
    }
  })();
}

start();
