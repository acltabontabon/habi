/** List-and-detail workbench of recommendations. */
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Group } from "../../bindings/Group";
import type { ProjectOverview } from "../../bindings/ProjectOverview";
import type { Recommendation } from "../../bindings/Recommendation";
import { Icon } from "../../components/Icon";
import { Empty, Status } from "../../components/ui";
import { Strand } from "../../components/Weave";
import { useDyes } from "../../lib/dye";
import { groupHint, groupLabel, installLabel, installTone, kindLabel } from "../../lib/format";
import { useNav } from "../../lib/nav";
import { useMedia } from "../../lib/useMedia";
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

/**
 * Whether an item is listed before any group is expanded: it fits or may
 * fit, or it is installed without rules. When none is, nothing fits yet.
 */
export function fitsProject(r: Recommendation): boolean {
  return r.group !== "notApplicable" && (r.group !== "available" || r.installState !== "notInstalled");
}

export function Workbench({ overview, itemKey }: { overview: ProjectOverview; itemKey?: string }) {
  const { navigate } = useNav();
  const [filter, setFilter] = useState("");
  const [showNotApplicable, setShowNotApplicable] = useState(false);
  const [showAvailable, setShowAvailable] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const projectId = overview.project.id;
  const dyes = useDyes();
  // Narrow windows show the list or one item, not both squeezed side by side.
  const narrow = useMedia("(max-width: 1020px)");
  const mode = narrow ? (itemKey ? " is-narrow is-detail" : " is-narrow is-list") : "";
  const toList = () => navigate({ name: "project", projectId, tab: "recommendations" });
  useEffect(() => {
    if (!narrow || !itemKey) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key !== "Escape" || target?.closest("input, textarea, [role=dialog]")) return;
      navigate({ name: "project", projectId, tab: "recommendations" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrow, itemKey, navigate, projectId]);

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

  // Items without applicability rules are not recommendations: unless shown,
  // only installed ones (which may need an update) are listed.
  const listed = (r: Recommendation) =>
    filter || fitsProject(r) || (r.group === "notApplicable" ? showNotApplicable : showAvailable);
  const navigable = visible.filter(listed);
  const unmatchedByLibrary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of overview.recommendations)
      if (r.group === "available" && r.installState === "notInstalled")
        counts.set(r.item.sourceName, (counts.get(r.item.sourceName) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [overview.recommendations]);
  // An item opened by name is shown even from a collapsed group (which then
  // opens); otherwise the first listed item is, never a hidden one.
  const chosen = overview.recommendations.find((r) => r.item.key === itemKey);
  const selected = chosen ?? navigable[0];
  useEffect(() => {
    if (!chosen || fitsProject(chosen)) return;
    if (chosen.group === "notApplicable") setShowNotApplicable(true);
    else setShowAvailable(true);
  }, [chosen]);

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
    <div className={`workbench${mode}`}>
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
            const collapsible = (group === "notApplicable" || group === "available") && !filter;
            const shown = group === "notApplicable" ? showNotApplicable : showAvailable;
            const setShown = group === "notApplicable" ? setShowNotApplicable : setShowAvailable;
            const members = visible.filter((r) => r.group === group && listed(r));
            const collapsed = collapsible && !shown;
            return (
              <section key={group} className="rec-group" aria-labelledby={`group-${group}`}>
                <header className="rec-group-head" data-group={group} title={groupHint[group]}>
                  <span className="rec-group-mark" aria-hidden="true" />
                  <h2 id={`group-${group}`} className="rec-group-title">
                    {groupLabel[group]}
                  </h2>
                  <span className="rec-group-count">
                    {counts[group]}
                    <span className="visually-hidden"> items</span>
                  </span>
                  {collapsible ? (
                    <button
                      type="button"
                      className="link-btn"
                      aria-expanded={!collapsed}
                      onClick={() => setShown((s) => !s)}
                    >
                      {collapsed ? "Show" : "Hide"}
                    </button>
                  ) : null}
                </header>
                {collapsed ? (
                  <p className="rec-group-hint">
                    {groupHint[group]}
                    {group === "available" && unmatchedByLibrary.length > 0
                      ? ` From ${unmatchedByLibrary.map(([name, n]) => `${name} (${n})`).join(", ")}.`
                      : null}
                  </p>
                ) : null}
                {members.length > 0 ? (
                  <ul className="rec-list">
                    {members.map((r) => {
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
                              <span className="provenance">
                                <Strand dye={dyes(r.item.sourceId)} size={13} />
                                {r.item.sourceName}
                              </span>
                              <span>{kindLabel[r.item.kind]}</span>
                              {r.item.requirement === "required" ? <span>required</span> : null}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </section>
            );
          })
        )}
      </div>
      <div className="workbench-detail">
        {narrow && itemKey ? (
          <button type="button" className="reader-back workbench-back" onClick={toList}>
            <Icon name="arrowLeft" size={14} />
            Recommendations
          </button>
        ) : null}
        {selected ? (
          <ItemDetailPane key={selected.item.key} overview={overview} recommendation={selected} />
        ) : (
          <Empty title="Nothing from your libraries fits this project yet">
            {overview.recommendations.length > 0
              ? "Show the groups on the left to browse what your libraries offer."
              : "Refresh the library or add skills to it."}
          </Empty>
        )}
      </div>
    </div>
  );
}
