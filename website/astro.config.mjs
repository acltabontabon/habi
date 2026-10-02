// @ts-check
import { defineConfig } from "astro/config";

// GitHub Pages serves the project at /habi/. SITE and BASE override both,
// for a custom domain later: SITE=https://habi.example BASE=/ pnpm build
export default defineConfig({
  site: process.env.SITE ?? "https://acltabontabon.github.io",
  base: process.env.BASE ?? "/habi",
  trailingSlash: "ignore",
  build: { inlineStylesheets: "always" },
  devToolbar: { enabled: false },
});
