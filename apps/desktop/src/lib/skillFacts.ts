/** Small facts about a library item, said the same way everywhere. */
import type { Condition } from "../bindings/Condition";
import type { LibraryItem } from "../bindings/LibraryItem";
import { tagLabel } from "./tags";

const CODE_FILE = /(^|\/)scripts\/|\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|ps1)$/;

/** Files in the package an agent could run. */
export function codeFiles(item: LibraryItem): number {
  return item.files.filter((f) => f.executable || CODE_FILE.test(f.path)).length;
}

/** What the author declared and where the terms are; never an interpretation. */
export function licenseText(declared: string | null, file: string | null): string {
  if (declared && file) return `${declared} (terms: ${file})`;
  if (declared) return declared;
  if (file) return `see ${file}`;
  return "none found";
}

/** A rule, in words. */
export function describeCondition(c: Condition): string {
  switch (c.op) {
    case "all":
      return c.items.map(describeCondition).join(" and ");
    case "any":
      return `(${c.items.map(describeCondition).join(" or ")})`;
    case "not":
      return `not ${describeCondition(c.item)}`;
    case "dependency":
      return `depends on ${c.name}${c.version ? ` ${c.version}` : ""}`;
    case "file":
      return `has files matching ${c.glob}`;
    case "tag":
      return tagLabel(c.tag);
  }
}

/** "github.com/obra/superpowers#brainstorming@8ca22db" → parts to show. */
export function lineageParts(value: string): { library: string; item: string; version: string } {
  const [library = value, rest = ""] = value.split("#");
  const [item = "", version = ""] = rest.split("@");
  return { library, item, version };
}
