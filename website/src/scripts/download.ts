/**
 * The Download buttons. Without this they open the latest release's page (`/releases/latest`),
 * which is a fine place to land. With it, each button goes straight to the installer for the
 * visitor's system and says which version that is. Any failure (offline, rate-limited, no
 * release yet) leaves the page link as it was.
 */
const API = "https://api.github.com/repos/acltabontabon/habi/releases/latest";
const CACHE = "habi-latest-release";

type Asset = { name: string; browser_download_url: string };
type Release = { tag_name: string; assets: Asset[] };
type Pick = { href: string; os: string; version: string };

/** The visitor's system, or "" when it is neither macOS nor Windows (phones, Linux). */
function system(): "macOS" | "Windows" | "" {
  const hints = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  const text = `${hints ?? ""} ${navigator.userAgent}`;
  if (/iPhone|iPad|Android|Linux|CrOS/i.test(text)) return "";
  if (/Mac/i.test(text)) return "macOS";
  if (/Win/i.test(text)) return "Windows";
  return "";
}

/** The one installer a system should get: the universal disk image, or the Windows setup program. */
function installer(release: Release, os: "macOS" | "Windows"): Pick | null {
  const wanted = os === "macOS" ? /\.dmg$/ : /-setup\.exe$/;
  const asset = release.assets.find((a) => wanted.test(a.name));
  if (!asset) return null;
  return { href: asset.browser_download_url, os, version: release.tag_name.replace(/^v/, "") };
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

export async function download() {
  const buttons = document.querySelectorAll<HTMLAnchorElement>("a[data-download]");
  const os = system();
  if (!buttons.length) return;
  try {
    const release = await latest();
    if (!release) return;
    const version = release.tag_name.replace(/^v/, "");
    for (const el of document.querySelectorAll<HTMLElement>("[data-download-version]")) el.textContent = `v${version} ·`;
    if (!os) return;
    const pick = installer(release, os);
    if (!pick) return;
    for (const button of buttons) {
      button.href = pick.href;
      const label = button.querySelector<HTMLElement>("[data-download-label]");
      if (label) label.textContent = `Download for ${pick.os}`;
    }
  } catch {
    /* the buttons still open the release page */
  }
}
