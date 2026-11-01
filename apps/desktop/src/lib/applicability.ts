/**
 * Applicability rules as sentences. The same `habi.yaml` conditions the
 * matcher evaluates, worded for the person deciding when Habi should suggest
 * a skill — never a second interpretation of them.
 */
import type { Condition } from "../bindings/Condition";
import type { ToolEntry } from "../bindings/ToolEntry";
import { tagPhrase } from "./tags";

/** Words, with an optional machine-shaped part set in mono. */
export type Phrase = { text: string; code?: string; after?: string };

export type ConditionKind = "tag" | "dependency" | "file";

export function conditionPhrase(kind: ConditionKind, value: string): Phrase {
  if (kind === "tag") return { text: `it ${tagPhrase(value)}` };
  if (kind === "dependency") return { text: "it depends on", code: value };
  return { text: "it has files matching", code: value };
}

export function toolPhrase(tool: ToolEntry): Phrase {
  const commands = tool.commands.filter((c) => c.trim() !== "");
  if (commands.length === 0) return { text: tool.name };
  return { text: `${tool.name} —`, code: commands.join(" or "), after: "on PATH or in the project" };
}

/** One readable tree node of conditions the builder may not be able to edit. */
export type ClauseNode =
  | { op: "all" | "any"; label: string; items: ClauseNode[] }
  | { op: "not"; label: string; item: ClauseNode }
  | { op: "leaf"; phrase: Phrase };

export function statementsFromCondition(condition: Condition): ClauseNode {
  switch (condition.op) {
    case "all":
      return { op: "all", label: "all of these", items: condition.items.map(statementsFromCondition) };
    case "any":
      return { op: "any", label: "any of these", items: condition.items.map(statementsFromCondition) };
    case "not":
      return { op: "not", label: "not when", item: statementsFromCondition(condition.item) };
    case "tag":
      return { op: "leaf", phrase: conditionPhrase("tag", condition.tag) };
    case "file":
      return { op: "leaf", phrase: conditionPhrase("file", condition.glob) };
    case "dependency": {
      const extra = [condition.ecosystem, condition.version].filter(Boolean).join(", ");
      return {
        op: "leaf",
        phrase: { text: "it depends on", code: condition.name, after: extra ? `(${extra})` : undefined },
      };
    }
    case "code":
      return {
        op: "leaf",
        phrase: {
          text: condition.kind === "import" ? "its code imports" : "its code uses the annotation",
          code: condition.name,
          after: condition.language ? `(${condition.language})` : undefined,
        },
      };
  }
}
