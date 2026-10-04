#!/usr/bin/env node
/**
 * Writes the Homebrew cask for a release, to standard output. The Homebrew workflow runs it
 * when a release is published and commits the result to the tap, so `brew install --cask
 * acltabontabon/tap/habi` always installs the latest published installer.
 *
 * Usage: node scripts/homebrew-cask.mjs <tag> <universal.dmg> [owner/repo] > habi.rb
 *
 * The checksum is computed from the installer itself, not read from a file beside it, so the
 * cask can never disagree with the bytes it points at.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SITE = "https://acltabontabon.com/habi/";
const IDENTIFIER = "com.acltabontabon.habi";

/** The cask for one release. `version` has no leading `v`. */
export function buildCask({ version, sha256, repo }) {
  return `cask "habi" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/${repo}/releases/download/v#{version}/Habi_#{version}_universal.dmg"
  name "Habi"
  desc "Find which agent skills fit a repository, and install them after a preview"
  homepage "${SITE}"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Habi updates itself with updates signed by its own key; brew should not fight that.
  auto_updates true
  depends_on :macos

  app "Habi.app"

  # Habi's data folder (My skills, the journal) is left alone on purpose.
  zap trash: [
    "~/Library/Caches/${IDENTIFIER}",
    "~/Library/Preferences/${IDENTIFIER}.plist",
    "~/Library/Saved Application State/${IDENTIFIER}.savedState",
    "~/Library/WebKit/${IDENTIFIER}",
  ]

  caveats <<~EOS
    Habi is not signed or notarized by Apple, so macOS asks you to confirm the first launch:
    open Habi once, then System Settings > Privacy & Security > Open Anyway.
    Homebrew does not bypass that check. After that, Habi updates itself.
  EOS
end
`;
}

/** The checksum Homebrew expects: hex SHA-256 of the file. */
export function sha256Of(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag, dmg, repo = "acltabontabon/habi"] = process.argv.slice(2);
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "") || !dmg) {
    console.error("Usage: node scripts/homebrew-cask.mjs <vX.Y.Z> <universal.dmg> [owner/repo]");
    process.exit(2);
  }
  process.stdout.write(buildCask({ version: tag.slice(1), sha256: sha256Of(dmg), repo }));
}
