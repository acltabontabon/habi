/** Readable line diff with line numbers and +/− markers (not color alone). */
import type { TextDiff } from "../bindings/TextDiff";

export function DiffView({ diff, label }: { diff: TextDiff; label: string }) {
  if (diff.binary) {
    return <p className="muted diff-empty">Binary content; only its digest is compared.</p>;
  }
  if (diff.hunks.length === 0) {
    return <p className="muted diff-empty">No line changes.</p>;
  }
  return (
    <section className="diff" aria-label={label}>
      {diff.hunks.map((hunk, h) => (
        <div key={h} className="diff-hunk">
          <div className="diff-hunk-head mono">{hunk.header}</div>
          <table className="diff-table">
            <tbody>
              {hunk.lines.map((line, i) => {
                const sign = line.tag === "added" ? "+" : line.tag === "removed" ? "−" : " ";
                return (
                  <tr key={i} className={`diff-line diff-${line.tag}`}>
                    <td className="diff-num" aria-hidden="true">
                      {line.oldLine ?? ""}
                    </td>
                    <td className="diff-num" aria-hidden="true">
                      {line.newLine ?? ""}
                    </td>
                    <td className="diff-sign">
                      <span aria-hidden="true">{sign}</span>
                      <span className="visually-hidden">
                        {line.tag === "added" ? "added" : line.tag === "removed" ? "removed" : "unchanged"}
                      </span>
                    </td>
                    <td className="diff-text mono">{line.text || " "}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
      {diff.truncated ? <p className="muted diff-empty">The rest of this diff is not shown.</p> : null}
    </section>
  );
}

export function DiffStat({ diff }: { diff: TextDiff }) {
  if (diff.binary) return <span className="diffstat">binary</span>;
  return (
    <span className="diffstat mono">
      <span className="visually-hidden">{`${diff.added} lines added, ${diff.removed} removed`}</span>
      <span className="diffstat-add" aria-hidden="true">
        +{diff.added}
      </span>{" "}
      <span className="diffstat-del" aria-hidden="true">
        −{diff.removed}
      </span>
    </span>
  );
}
