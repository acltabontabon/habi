/** What still has to be finished before a draft can be installed, exported or shared. */
import type { Diagnostic } from "../../bindings/Diagnostic";
import { Button } from "../../components/ui";

/** Where in the skill editor a problem is fixed. */
export type FixTarget = "purpose" | "applicability" | "files";

/** Validator wording, rephrased for the person writing the skill. */
export function plainProblem(d: Diagnostic): { text: string; fix: FixTarget | null } {
  const m = d.message;
  if (m === "SKILL.md has no `description`") {
    return {
      text: "Describe what the skill helps with and when an agent should use it. Agents decide whether to load a skill from this text alone.",
      fix: "purpose",
    };
  }
  if (m === "SKILL.md has no `name`" || m.startsWith("`name` ")) {
    return {
      text: `Give the skill a valid identifier${m.startsWith("`name` ") ? ` — it ${m.slice(7)}` : ""}.`,
      fix: "purpose",
    };
  }
  if (d.path && /(^|\/)habi\.ya?ml$/.test(d.path)) {
    return { text: `The applicability rules need attention: ${m}`, fix: "applicability" };
  }
  return { text: d.path ? `${d.path}: ${m}` : m, fix: d.path ? "files" : null };
}

const fixLabel: Record<FixTarget, string> = {
  purpose: "Open Purpose",
  applicability: "Open Applicability",
  files: "Open Files",
};

export function Unfinished({
  diagnostics,
  action,
  onFix,
}: {
  diagnostics: Diagnostic[];
  action: string;
  /** Takes the author to the place where the problem is fixed. */
  onFix?: (target: FixTarget) => void;
}) {
  return (
    <div className="unfinished" role="status">
      <p className="unfinished-title">
        Before it can be {action}, {diagnostics.length === 1 ? "one thing needs" : "a few things need"}{" "}
        finishing:
      </p>
      <ul>
        {diagnostics.map((d, i) => {
          const problem = plainProblem(d);
          return (
            <li key={i}>
              {problem.text}{" "}
              {onFix && problem.fix ? (
                <Button size="sm" variant="quiet" onClick={() => onFix(problem.fix as FixTarget)}>
                  {fixLabel[problem.fix]}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="muted">The draft is saved as it is. Nothing is lost by finishing later.</p>
    </div>
  );
}
