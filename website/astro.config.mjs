// @ts-check
import { defineConfig } from "astro/config";

// GitHub Pages serves the project at acltabontabon.com/habi/ (the account's
// custom domain). SITE and BASE override both, e.g. for a domain of its own:
// SITE=https://habi.example BASE=/ pnpm build
export default defineConfig({
  site: process.env.SITE ?? "https://acltabontabon.com",
  base: process.env.BASE ?? "/habi",
  trailingSlash: "ignore",
  build: { inlineStylesheets: "always" },
  devToolbar: { enabled: false },
});
