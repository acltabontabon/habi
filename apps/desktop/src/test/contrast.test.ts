import { describe, expect, it } from "vitest";
import tokens from "../styles/tokens.css?raw";

// jsdom cannot resolve CSS custom properties, so axe's contrast rule cannot
// see the real colors; the text tokens are checked against every surface here.
const TEXT = ["--ink", "--ink-soft", "--ink-muted", "--ink-faint"];
const SURFACES = [
  "--paper",
  "--paper-raised",
  "--paper-sunken",
  "--paper-selected",
  "--muted-wash",
  "--thread-wash",
];

function block(selector: string): Record<string, string> {
  const start = tokens.indexOf(`${selector} {`);
  const body = tokens.slice(start, tokens.indexOf("\n}", start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("text colors", () => {
  const light = block(":root");
  const dark = { ...light, ...block(':root[data-theme="dark"]') };
  for (const [theme, colors] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it(`reach 4.5:1 on every surface in the ${theme} theme`, () => {
      expect(Object.keys(colors)).toEqual(expect.arrayContaining([...TEXT, ...SURFACES]));
      const failing = TEXT.flatMap((text) =>
        SURFACES.map((surface) => {
          const ratio = contrast(colors[text] ?? "", colors[surface] ?? "");
          return ratio < 4.5 ? `${text} on ${surface}: ${ratio.toFixed(2)}` : null;
        }),
      ).filter(Boolean);
      expect(failing).toEqual([]);
    });
  }
});
