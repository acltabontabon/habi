/** What still has to be finished before a draft can be installed, exported or shared. */
import type { Diagnostic } from "../../bindings/Diagnostic";
import { Button } from "../../components/ui";
import { type NavTarget, plainProblem, targetLabel } from "../../lib/studioNav";

export function Unfinished({
  diagnostics,
  action,
  onFix,
}: {
  diagnostics: Diagnostic[];
  action: string;
  /** Takes the author to the place where the problem is fixed. */
  onFix?: (target: NavTarget) => void;
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
          const target = problem.target;
          return (
            <li key={i}>
              {problem.text}{" "}
              {onFix && target ? (
                <Button size="sm" variant="quiet" onClick={() => onFix(target)}>
                  {targetLabel(target)}
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
