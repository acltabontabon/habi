// vite.config.ts reads CHANGELOG.md and package.json with Node's fs; this is the one call, so the
// app does not take on @types/node for it.
declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: "utf8"): string;
}
declare module "node:url" {
  export function fileURLToPath(url: URL | string): string;
}
