/**
 * Applicability rules as sentences. The same `habi.yaml` conditions the
 * matcher evaluates, worded for the person deciding when Habi should suggest
 * a skill — never a second interpretation of them.
 */
import type { Condition } from "../bindings/Condition";
import type { ShareForm } from "../bindings/ShareForm";
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

export type RuleSummary = {
  mode: "all" | "any";
  applies: { kind: ConditionKind; value: string; phrase: Phrase }[];
  excludes: { kind: ConditionKind; value: string; phrase: Phrase }[];
  tools: { tool: ToolEntry; phrase: Phrase }[];
  scope: "module" | "repository";
  /** Nothing that makes Habi suggest it: the skill is for manual use. */
  empty: boolean;
};

/** The builder form, as the statements it shows. */
export function statementsFromForm(form: ShareForm): RuleSummary {
  const applies = [
    ...form.appliesTags.map((value) => ({ kind: "tag" as const, value })),
    ...form.appliesDependencies.map((value) => ({ kind: "dependency" as const, value })),
    ...form.appliesFiles.map((value) => ({ kind: "file" as const, value })),
  ].map((c) => ({ ...c, phrase: conditionPhrase(c.kind, c.value) }));
  const excludes = [
    ...form.excludeTags.map((value) => ({ kind: "tag" as const, value })),
    ...form.excludeDependencies.map((value) => ({ kind: "dependency" as const, value })),
  ].map((c) => ({ ...c, phrase: conditionPhrase(c.kind, c.value) }));
  return {
    mode: form.matchMode,
    applies,
    excludes,
    tools: form.tools.filter((t) => t.name.trim() !== "").map((tool) => ({ tool, phrase: toolPhrase(tool) })),
    scope: form.repositoryScope ? "repository" : "module",
    empty: applies.length === 0,
  };
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
  }
}

function words(p: Phrase): string {
  return [p.text, p.code, p.after].filter(Boolean).join(" ");
}

function joined(items: string[], last: "and" | "or"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
}

/** The whole rule in one sentence, for places with room for a single line. */
export function ruleSentence(summary: RuleSummary): string {
  if (summary.empty) return "Not suggested on its own — always available to use by hand.";
  const when = joined(
    summary.applies.map((a) => words(a.phrase)),
    summary.mode === "all" ? "and" : "or",
  );
  const unless =
    summary.excludes.length > 0
      ? `, unless ${joined(
          summary.excludes.map((e) => words(e.phrase)),
          "or",
        )}`
      : "";
  return `Suggested when ${when}${unless}.`;
}
