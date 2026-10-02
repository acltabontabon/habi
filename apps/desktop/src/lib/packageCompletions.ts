/**
 * Completing package-relative paths while writing instructions: after a
 * Markdown link's "](" or inside backticks, the package's own files are
 * offered, so references are written exactly as they will resolve.
 */
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";

export function fileKind(path: string): string {
  if (path.startsWith("scripts/")) return "script";
  if (path.startsWith("references/")) return "reference";
  if (path.startsWith("assets/")) return "asset";
  return "file";
}

/** Where a path is being typed, and what has been typed of it. */
export function pathAt(before: string): { typed: string; inCode: boolean } | null {
  const link = /\]\(([^)\s]*)$/.exec(before);
  if (link) return { typed: link[1] ?? "", inCode: false };
  // An odd number of backticks on the line: the caret is inside a code span.
  const ticks = (before.match(/`/g) ?? []).length;
  if (ticks % 2 === 1) {
    const code = /`([\w./-]*)$/.exec(before);
    if (code) return { typed: code[1] ?? "", inCode: true };
  }
  return null;
}

export function packageCompletions(paths: () => string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const at = pathAt(before);
    if (!at) return null;
    // In code spans, wait for something path-like before offering anything.
    if (at.inCode && !context.explicit && !/[/.]/.test(at.typed) && at.typed.length < 2) return null;
    const options = paths()
      .filter((p) => p !== "SKILL.md" && !/^habi\.ya?ml$/.test(p))
      .map((p) => ({ label: p, detail: fileKind(p), type: "text" }));
    if (options.length === 0) return null;
    return { from: context.pos - at.typed.length, options, validFor: /^[\w./-]*$/ };
  };
}
