/**
 * All of a composition at once, for when the margin isn't enough. Laid out like a
 * weaver's draft: each skill a thread running down, each section of the
 * instructions a row across, a knot where they meet. It's worked out from the
 * document and there's nothing to arrange, so ten skills read as clearly as two.
 * It's also a real table, so a screen reader can walk it cell by cell.
 */
import { useMemo, useState } from "react";
import type { Composition } from "../../../../bindings/Composition";
import type { Dependency } from "../../../../bindings/Dependency";
import { Icon } from "../../../../components/Icon";
import { Button } from "../../../../components/ui";
import { knotColor, titleOfName } from "./knots";
import type { Overview as OverviewData } from "./overviewData";
import { roleWords } from "./roles";

const statusOf = (d: Dependency | undefined) =>
  !d
    ? "unsure"
    : d.status === "missing"
      ? "missing"
      : d.status === "exact" || d.status === "named"
        ? "found"
        : "unsure";

export function Overview({
  overview,
  composition,
  titleOf,
  onGo,
  onUse,
  onAddBack,
  onForget,
  onClose,
}: {
  overview: OverviewData;
  composition: Composition | undefined;
  titleOf: (name: string) => string;
  /** Takes the author to that place on the page. */
  onGo: (pos: number) => void;
  /** Opens that use. */
  onUse: (pos: number) => void;
  onAddBack: (name: string) => void;
  onForget: (name: string) => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const deps = useMemo(
    () => new Map((composition?.dependencies ?? []).map((d) => [d.name, d])),
    [composition],
  );
  const missing = overview.names.filter((n) => statusOf(deps.get(n)) === "missing");
  const opened = open ? deps.get(open) : undefined;
  return (
    <aside className="weave" aria-label="How the skills fit">
      <header className="shelf-head">
        <h2>How the skills fit</h2>
        <button type="button" className="shelf-close" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </header>
      <p className="weave-truth">
        This is what the instructions say. Each agent decides for itself when to use a skill, so this isn't a
        route it will follow.
      </p>

      {overview.names.length === 0 ? (
        <p className="shelf-empty">
          No skills are part of this one yet. Press ⌘⇧K, or type /skill in the instructions, to add one.
        </p>
      ) : (
        <div className="weave-scroll">
          <table className="weave-table">
            <caption className="visually-hidden">Which sections of the instructions use which skills</caption>
            <thead>
              <tr>
                <td />
                {overview.names.map((name) => {
                  const status = statusOf(deps.get(name));
                  return (
                    <th key={name} scope="col" className={`weave-warp is-${status}`}>
                      <button
                        type="button"
                        aria-expanded={open === name}
                        aria-label={`${titleOf(name)}${status === "missing" ? ", not found here" : ""}: what it uses`}
                        onClick={() => setOpen(open === name ? null : name)}
                      >
                        <span className="weave-name">{titleOf(name)}</span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {overview.rows.map((row, r) => (
                <tr
                  key={`${row.pos}:${row.title}`}
                  style={{ "--depth": Math.max(0, row.level - 1) } as React.CSSProperties}
                >
                  <th scope="row">
                    <button type="button" className="weave-row" onClick={() => onGo(row.pos)}>
                      {row.title}
                    </button>
                  </th>
                  {overview.names.map((name) => {
                    const here = overview.uses.filter((u) => u.row === r && u.name === name);
                    const status = statusOf(deps.get(name));
                    const first = here[0];
                    return (
                      <td key={name} className={`weave-cell is-${status}`}>
                        {first ? (
                          <button
                            type="button"
                            className="weave-knot"
                            style={status === "missing" ? undefined : { background: knotColor(name) }}
                            aria-label={`${titleOf(name)} in ${row.title}, ${here.map((u) => roleWords(u.role)).join(", ")}`}
                            title={`${titleOf(name)}: ${here.map((u) => roleWords(u.role)).join(", ")}`}
                            onClick={() => onUse(first.pos)}
                          >
                            {here.length > 1 ? here.length : null}
                          </button>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {opened ? (
        <section className="weave-detail">
          <h3>{titleOf(opened.name)}</h3>
          {opened.nested.length === 0 ? (
            <p>It doesn't name any other skills.</p>
          ) : (
            <ul>
              {opened.nested.map((n) => (
                <li key={n.name} className={n.status === "missing" ? "is-ghost" : undefined}>
                  {titleOfName(n.name)}{" "}
                  <span>
                    {n.explicit ? "part of it" : "mentioned"}
                    {n.status === "missing" ? ", not found here" : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {missing.length ? (
        <p className="weave-note">
          {missing.length === 1 ? `${titleOf(missing[0] ?? "")} isn't` : `${missing.length} skills aren't`} on
          this machine or in your libraries. An agent can't use what it can't find. Open{" "}
          {missing.length === 1 ? "it" : "one"} on the page to see what to do.
        </p>
      ) : null}

      {composition?.cycles.length ? (
        <p className="weave-note">
          These name each other in a circle:{" "}
          {composition.cycles.map((c) => c.map(titleOf).join(" → ")).join("; ")}. Agents can usually cope, but
          it's worth checking that's what you meant.
        </p>
      ) : null}

      {composition?.unmentioned.length ? (
        <section className="weave-detail">
          <h3>No longer mentioned in the instructions</h3>
          <p>
            This skill says it uses these, but the words don't. It can't be installed or shared until you
            decide.
          </p>
          <ul>
            {composition.unmentioned.map((name) => (
              <li key={name} className="weave-decide">
                {titleOf(name)}
                <span>
                  <Button onClick={() => onAddBack(name)}>Add a sentence back</Button>
                  <Button variant="quiet" onClick={() => onForget(name)}>
                    Forget it
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {composition?.mentioned.length ? (
        <section className="weave-detail">
          <h3>Mentioned, not part of this skill</h3>
          <p>These are only named in the words. Habi hasn't counted them.</p>
          <ul>
            {composition.mentioned.map((m) => (
              <li key={`${m.plugin ?? ""}:${m.name}`}>{titleOf(m.name)}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}
