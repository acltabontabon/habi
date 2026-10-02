// Renders the share image (public/og.png) from the /og/ page with headless Chrome.
// Start `pnpm dev` first, then run `pnpm og`. Set CHROME_PATH to use another Chrome or
// Chromium; OG_URL to render from another address.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const defaults = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  win32: [
    `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
};

const chrome =
  process.env.CHROME_PATH ??
  (defaults[process.platform] ?? []).find((path) => existsSync(path)) ??
  // Elsewhere, expect Chrome or Chromium on the PATH.
  "google-chrome";

const url = process.env.OG_URL ?? "http://localhost:4321/habi/og/";
const result = spawnSync(
  chrome,
  [
    "--headless",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=1200,630",
    "--virtual-time-budget=4000",
    "--screenshot=public/og.png",
    url,
  ],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(`Could not run Chrome at ${chrome}: ${result.error.message}`);
  console.error("Set CHROME_PATH to a Chrome or Chromium executable.");
  process.exit(1);
}
process.exit(result.status ?? 1);
