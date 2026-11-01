/** A knot's colour. One colour: a different one per skill would read as a status it isn't. */
export const KNOT = "var(--thread)";

/** The words of a skill's name, for when nothing better is known. */
export function titleOfName(name: string): string {
  const words = name.split("-").filter(Boolean).join(" ");
  return words ? (words[0]?.toUpperCase() ?? "") + words.slice(1) : name;
}
