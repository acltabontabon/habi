import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { parseChangelog } from "../../scripts/changelog.mjs";

// What's new is the released part of CHANGELOG.md, fixed when the app is built. Unreleased notes
// stay out, and a malformed changelog stops the build rather than reaching people.
const CHANGELOG = parseChangelog(readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8"));
const VERSION: string = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

/** What the app lists. While developing, the Unreleased notes stand in for the version being built. */
function releasesFor(command: "serve" | "build") {
  const { releases, unreleased } = CHANGELOG;
  if (command !== "serve" || !unreleased || releases.some((r) => r.version === VERSION)) return releases;
  const today = new Date().toISOString().slice(0, 10);
  return [{ version: VERSION, date: today, prerelease: false, markdown: unreleased }, ...releases];
}

const CHANGELOG_PATH = fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url));

/** The notes are read when the config loads, so the dev server restarts when the changelog is edited. */
function changelogWatch(): Plugin {
  return {
    name: "habi-changelog-watch",
    configureServer(server) {
      server.watcher.add(CHANGELOG_PATH);
      server.watcher.on("change", (file) => {
        if (file === CHANGELOG_PATH) void server.restart();
      });
    },
  };
}

// Tauri serves the built files; the dev server is only used during development.
// HABI_UI_PORT / HABI_BRIDGE_PORT let a second dev pair run alongside the default one.
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, ".", "");
  const uiPort = Number(env.HABI_UI_PORT || 1420);
  const bridgePort = Number(env.HABI_BRIDGE_PORT || 1430);
  return {
    plugins: [react(), changelogWatch()],
    define: { __HABI_RELEASES__: JSON.stringify(releasesFor(command)) },
    clearScreen: false,
    server: {
      port: uiPort,
      strictPort: true,
      host: "127.0.0.1",
      // Development bridge to the real core (see crates/habi-core/examples/dev_bridge.rs).
      proxy: {
        "/__habi": {
          target: `http://127.0.0.1:${bridgePort}`,
          rewrite: (path) => path.replace(/^\/__habi/, ""),
        },
      },
    },
    build: {
      target: "es2022",
      sourcemap: false,
      chunkSizeWarningLimit: 1500,
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      // Only the design tokens are read (as text, by the contrast test).
      css: { include: [/tokens\.css/] },
    },
  };
});
