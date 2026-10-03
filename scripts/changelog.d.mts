// Types for changelog.mjs, for the desktop build (apps/desktop/vite.config.ts) and the app (src/lib/release.ts).
export type Release = { version: string; date: string; prerelease: boolean; markdown: string };
export const SEMVER: RegExp;
export function isPrerelease(version: string): boolean;
export function parseChangelog(text: string): { unreleased: string; releases: Release[] };
