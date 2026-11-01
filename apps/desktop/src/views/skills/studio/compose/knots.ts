/** A skill's colour on the page: from its name, so it's the same knot wherever that skill appears. */
const DYES = 8;

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function knotColor(name: string): string {
  return `var(--dye-${hash(name) % DYES})`;
}

/** The words of a skill's name, for when nothing better is known. */
export function titleOfName(name: string): string {
  const words = name.split("-").filter(Boolean).join(" ");
  return words ? (words[0]?.toUpperCase() ?? "") + words.slice(1) : name;
}
