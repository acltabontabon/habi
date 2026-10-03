/**
 * CHANGELOG.md, read the same way everywhere it is used: the app's What's new
 * (apps/desktop/vite.config.ts), the update offered to people already running Habi, and the
 * GitHub release (scripts/updater-manifest.mjs). No dependencies.
 *
 *   ## Unreleased                    changes not released yet; never shown in the app
 *   ## 0.2.0 - 2026-11-03            a release: its semantic version and ISO date
 *   ### Discover                     headings and bullets below it are the notes, as Markdown
 *   - What people can now do.
 *
 * `## [0.2.0] - 2026-11-03` (Keep a Changelog's brackets) is read the same way. A release's
 * notes are everything between its heading and the next `## ` heading. HTML comments are
 * dropped, so maintainer notes can sit in the file without reaching the app or a release.
 * The parser refuses what it cannot place, so a release cannot publish a malformed entry.
 */

export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

/** Whether a version is a prerelease (0.2.0-rc.1), per semver. */
export const isPrerelease = (version) => SEMVER.exec(version)?.[4] !== undefined;

/** Whether "2026-02-31" is a real day: it must survive a round trip through a Date. */
const isCalendarDate = (date) => {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date);
};

/**
 * @typedef {{ version: string, date: string, prerelease: boolean, markdown: string }} Release
 */

/**
 * Parses the changelog into its released versions, newest first as written. `unreleased` is
 * the text under the Unreleased heading (possibly empty).
 * @returns {{ unreleased: string, releases: Release[] }}
 */
export function parseChangelog(text) {
  const src = text.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  if (!/^# Changelog\s*$/m.test(src.split("\n## ")[0] ?? "")) {
    throw new Error("CHANGELOG.md: start with “# Changelog”");
  }
  /** @type {Release[]} */
  const releases = [];
  let unreleased = "";
  let current = null;
  let body = [];
  let sawUnreleased = false;

  const close = () => {
    if (!current) return;
    const markdown = body.join("\n").replace(/^\n+|\s+$/g, "");
    if (current === "unreleased") unreleased = markdown;
    else {
      if (!/^[-*] /m.test(markdown)) throw new Error(`CHANGELOG.md: ${current.version} lists no changes`);
      releases.push({ ...current, markdown });
    }
    body = [];
  };

  for (const line of src.split("\n")) {
    if (!/^## /.test(line)) {
      if (current) body.push(line);
      continue;
    }
    close();
    const unreleasedHeading = /^## \[?Unreleased\]?\s*$/i.test(line);
    if (unreleasedHeading) {
      if (sawUnreleased || releases.length) {
        throw new Error("CHANGELOG.md: “## Unreleased” comes once, before every release");
      }
      sawUnreleased = true;
      current = "unreleased";
      continue;
    }
    const heading = /^## \[?([^\]\s]+)\]?(?:\s+-\s+(\S+))?\s*$/.exec(line);
    const version = heading?.[1] ?? "";
    const date = heading?.[2] ?? "";
    if (!SEMVER.test(version)) {
      throw new Error(`CHANGELOG.md: unexpected heading “${line}” (use “## Unreleased” or “## x.y.z - YYYY-MM-DD”)`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isCalendarDate(date)) {
      throw new Error(`CHANGELOG.md: ${version} needs a release date as YYYY-MM-DD (“## ${version} - 2026-01-31”)`);
    }
    if (releases.some((r) => r.version === version)) throw new Error(`CHANGELOG.md: ${version} appears twice`);
    current = { version, date, prerelease: isPrerelease(version) };
  }
  close();
  return { unreleased, releases };
}
