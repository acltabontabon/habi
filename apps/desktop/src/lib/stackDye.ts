/**
 * A stack's dye: one natural dye per family of languages and build tools,
 * so a project wears the same color wherever it appears (its thread in the
 * project chooser, its cloth on the project page). Tools without a language
 * of their own (Docker, CI) have none.
 */
const FAMILY: Record<string, string> = {
  Rust: "var(--dye-1)",
  Swift: "var(--dye-1)",
  Node: "var(--dye-2)",
  Deno: "var(--dye-2)",
  JavaScript: "var(--dye-2)",
  TypeScript: "var(--dye-2)",
  Java: "var(--dye-0)",
  Kotlin: "var(--dye-0)",
  Maven: "var(--dye-0)",
  Gradle: "var(--dye-0)",
  Ant: "var(--dye-0)",
  Go: "var(--dye-4)",
  Dart: "var(--dye-4)",
  Python: "var(--dye-6)",
  Ruby: "var(--dye-3)",
  Scala: "var(--dye-3)",
  PHP: "var(--dye-7)",
  Elixir: "var(--dye-7)",
  "C#": "var(--dye-5)",
};

export function stackDye(name: string): string | undefined {
  return FAMILY[name];
}

/** The distinct dyes of `names`, in order. */
export function stackDyes(names: string[]): string[] {
  return [...new Set(names.flatMap((n) => stackDye(n) ?? []))];
}
