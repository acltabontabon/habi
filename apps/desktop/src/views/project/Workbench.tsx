/** List-and-detail workbench of recommendations. */
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import type { Group } from "../../bindings/Group";
import type { ProjectOverview } from "../../bindings/ProjectOverview";
import type { Recommendation } from "../../bindings/Recommendation";
import { Icon } from "../../components/Icon";
import { Empty, Status } from "../../components/ui";
import { groupHint, groupLabel, installLabel, installTone, kindLabel } from "../../lib/format";
import { useNav } from "../../lib/nav";
import { ItemDetailPane } from "./ItemDetailPane";

const GROUPS: Group[] = ["required", "relevant", "needsInformation", "available", "notApplicable"];

function rowStatus(r: Recommendation) {
  if (r.installState !== "notInstalled")
    return <Status tone={installTone[r.installState]}>{installLabel[r.installState]}</Status>;
  if (r.applicability.applicability === "needsInformation")
    return <Status tone="unknown">Needs information</Status>;
  if (r.readiness.state === "missing" && r.applicability.applicability === "applies")
    return <Status tone="warn">Prerequisite missing</Status>;
  return null;
}

export function Workbench({ overview, itemKey }: { overview: ProjectOverview; itemKey?: string }) {
  const { navigate } = useNav();
  const [filter, setFilter] = useState("");
  const [showNotApplicable, setShowNotApplicable] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const projectId = overview.project.id;

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return overview.recommendations.filter(
      (r) =>
        !q ||
        r.item.title.toLowerCase().includes(q) ||
        r.item.id.includes(q) ||
        r.item.description.toLowerCase().includes(q),
    );
  }, [overview.recommendations, filter]);

  const navigable = visible.filter((r) => r.group !== "notApplicable" || showNotApplicable || filter);
  const selected =
    overview.recommendations.find((r) => r.item.key === itemKey) ??
    navigable[0] ??
    overview.recommendations[0];

  const select = (r: Recommendation) =>
    navigate({ name: "project", projectId, tab: "recommendations", itemKey: r.item.key });

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "j" && e.key !== "k") return;
    e.preventDefault();
    const index = navigable.findIndex((r) => r.item.key === selected?.item.key);
    const next = e.key === "ArrowDown" || e.key === "j" ? index + 1 : index - 1;
    const target = navigable[Math.max(0, Math.min(navigable.length - 1, next))];
    if (target) {
      select(target);
      requestAnimationFrame(() => {
        listRef.current
          ?.querySelector<HTMLButtonElement>(`[data-key="${CSS.escape(target.item.key)}"]`)
          ?.focus();
      });
    }
  };

  const counts = Object.fromEntries(
    GROUPS.map((g) => [g, visible.filter((r) => r.group === g).length]),
  ) as Record<Group, number>;

  return (
    <div className="workbench">
      <div className="workbench-list" ref={listRef}>
        <div className="list-filter">
          <Icon name="search" />
          <label className="visually-hidden" htmlFor="rec-filter">
            Filter recommendations
          </label>
          <input
            id="rec-filter"
            type="search"
            placeholder="Filter skills and workflows"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {visible.length === 0 ? (
          <Empty title="Nothing matches that filter." />
        ) : (
          GROUPS.filter((g) => counts[g] > 0).map((group) => {
            const collapsed = group === "notApplicable" && !showNotApplicable && !filter;
            return (
              <section key={group} className="rec-group" aria-labelledby={`group-${group}`}>
                <header className="rec-group-head">
                  <h2 id={`group-${group}`} className="rec-group-title">
                    {groupLabel[group]} <span className="rec-group-count">{counts[group]}</span>
                  </h2>
                  {group === "notApplicable" && !filter ? (
                    <button
                      type="button"
                      className="link-btn"
                      aria-expanded={!collapsed}
                      onClick={() => setShowNotApplicable((s) => !s)}
                    >
                      {collapsed ? "Show" : "Hide"}
                    </button>
                  ) : null}
                </header>
                {collapsed ? (
                  <p className="rec-group-hint">{groupHint[group]}</p>
                ) : (
                  <ul className="rec-list">
                    {visible
                      .filter((r) => r.group === group)
                      .map((r) => {
                        const active = r.item.key === selected?.item.key;
                        return (
                          <li key={r.item.key}>
                            <button
                              type="button"
                              data-key={r.item.key}
                              className={`rec-row${active ? " is-active" : ""}`}
                              aria-current={active ? "true" : undefined}
                              onClick={() => select(r)}
                              onKeyDown={onKeyDown}
                            >
                              <span className="rec-row-top">
                                <span className="rec-row-title">{r.item.title}</span>
                                {rowStatus(r)}
                              </span>
                              <span className="rec-row-reason">{r.applicability.reason}</span>
                              <span className="rec-row-meta">
                                {kindLabel[r.item.kind]} · {r.item.sourceName}
                                {r.item.requirement === "required" ? " · required" : ""}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                  </ul>
                )}
              </section>
            );
          })
        )}
      </div>
      <div className="workbench-detail">
        {selected ? (
          <ItemDetailPane key={selected.item.key} overview={overview} recommendation={selected} />
        ) : (
          <Empty title="Nothing in your library yet">Refresh the library or add skills to it.</Empty>
        )}
      </div>
    </div>
  );
}
