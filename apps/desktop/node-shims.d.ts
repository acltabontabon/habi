// vite.config.ts reads CHANGELOG.md and package.json with Node's fs, and the round-trip test can
// walk a local folder of skills. These are the only calls, so the app does not take on @types/node.
declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: "utf8"): string;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { isDirectory(): boolean };
}
declare module "node:path" {
  export function join(...parts: string[]): string;
}
declare const process: { env: Record<string, string | undefined> };
declare module "node:url" {
  export function fileURLToPath(url: URL | string): string;
}
