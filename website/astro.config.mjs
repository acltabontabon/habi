// @ts-check
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";

// The repository's docs/, published under /docs/ by src/lib/docs.ts.
const docsDir = fileURLToPath(new URL("../docs/", import.meta.url));

/**
 * In development, an edited doc reloads the page; the docs are rendered again on every request.
 * @type {() => NonNullable<NonNullable<import("astro").AstroUserConfig["vite"]>["plugins"]>[number]}
 */
function docsReload() {
  return {
    name: "habi-docs-reload",
    configureServer(server) {
      server.watcher.add(docsDir);
      server.watcher.on("change", (file) => {
        if (file.startsWith(docsDir)) server.ws.send({ type: "full-reload" });
      });
    },
  };
}

// GitHub Pages serves the project at acltabontabon.com/habi/ (the account's
// custom domain). SITE and BASE override both, e.g. for a domain of its own:
// SITE=https://habi.example BASE=/ pnpm build
export default defineConfig({
  site: process.env.SITE ?? "https://acltabontabon.com",
  base: process.env.BASE ?? "/habi",
  trailingSlash: "ignore",
  build: { inlineStylesheets: "always" },
  devToolbar: { enabled: false },
  vite: {
    define: { __HABI_DOCS_DIR__: JSON.stringify(docsDir) },
    plugins: [docsReload()],
  },
});
