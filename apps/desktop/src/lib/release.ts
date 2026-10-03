/**
 * The released notes, fixed at build time from CHANGELOG.md (vite.config.ts). Only released
 * entries are here: never the Unreleased notes or maintainer comments.
 */
import type { Release } from "../../../../scripts/changelog.d.mts";

export type { Release };

declare const __HABI_RELEASES__: Release[];

/** Newest first, as the changelog lists them. */
export const RELEASES: Release[] = __HABI_RELEASES__;

/** "2026-09-28" → "28 September 2026", read as a calendar date (no timezone shift). */
export function releaseDate(date: string, locale?: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
