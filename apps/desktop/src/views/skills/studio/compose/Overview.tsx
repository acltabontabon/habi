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
import { KNOT } from "./knots";
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
  onTie,
  onMoveUse,
  onMoveSection,
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
  /** Ties a knot: this skill, used in this section. */
  onTie: (name: string, row: number) => void;
  /** Moves a use's sentence to another section. */
  onMoveUse: (pos: number, row: number) => void;
  /** Moves a section to before another (or to the end). */
  onMoveSection: (row: number, before: number) => void;
  onAddBack: (name: string) => void;
  onForget: (name: string) => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);

  /** Follows the pointer over the rows, and says which row it's let go on. */
  const followRows = (start: PointerEvent, land: (row: number) => void, click: () => void) => {
    start.preventDefault();
    const rowAt = (x: number, y: number) => {
      const tr = document.elementFromPoint(x, y)?.closest<HTMLElement>("tr[data-row]");
      return tr ? Number(tr.dataset.row) : null;
    };
    let moved = false;
    const onMove = (e: PointerEvent) => {
      if (!moved && Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) < 4) return;
      moved = true;
      setOver(rowAt(e.clientX, e.clientY));
    };
    const finish = (e: PointerEvent) => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", finish, true);
      setOver(null);
      if (!moved) return click();
      const row = rowAt(e.clientX, e.clientY);
      if (row !== null) land(row);
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", finish, true);
  };
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
          No skills linked yet. Press ⌘⇧K, or type /skill in the instructions, to add one.
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
                  data-row={r}
                  className={over === r ? "is-over" : undefined}
                  key={`${row.pos}:${row.title}`}
                  style={{ "--depth": Math.max(0, row.level - 1) } as React.CSSProperties}
                >
                  <th scope="row">
                    <button
                      type="button"
                      className="weave-row"
                      title="Click to go there. Drag to move the section. Alt+arrows from the keyboard."
                      onPointerDown={(e) =>
                        followRows(
                          e.nativeEvent,
                          (to) => {
                            if (to !== r) onMoveSection(r, to > r ? to + 1 : to);
                          },
                          () => onGo(row.pos),
                        )
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") onGo(row.pos);
                        if (e.altKey && e.key === "ArrowUp" && r > 0) onMoveSection(r, r - 1);
                        if (e.altKey && e.key === "ArrowDown" && r < overview.rows.length - 1)
                          onMoveSection(r, r + 2);
                      }}
                    >
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
                            style={status === "missing" ? undefined : { background: KNOT }}
                            aria-label={`${titleOf(name)} in ${row.title}, ${here.map((u) => roleWords(u.role)).join(", ")}`}
                            title={`${titleOf(name)}: ${here.map((u) => roleWords(u.role)).join(", ")}`}
                            onPointerDown={(e) =>
                              followRows(
                                e.nativeEvent,
                                (to) => {
                                  if (to !== r) onMoveUse(first.pos, to);
                                },
                                () => onUse(first.pos),
                              )
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") onUse(first.pos);
                            }}
                          >
                            {here.length > 1 ? here.length : null}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="weave-tie"
                            aria-label={`Use ${titleOf(name)} in ${row.title}`}
                            title={`Tie a knot: use ${titleOf(name)} in ${row.title}`}
                            onClick={() => onTie(name, r)}
                          />
                        )}
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
                  {titleOf(n.name)}{" "}
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
          <h3>Mentioned, not linked</h3>
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
