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
import { useKnowledge } from "../../lib/queries";
import { useMedia } from "../../lib/useMedia";
import { ReviewDialog, type ReviewRequest } from "../review/ReviewDialog";
import { HereDetail, hereItems } from "./AlreadyHere";
import { ItemDetailPane } from "./ItemDetailPane";

const GROUPS: Group[] = ["required", "relevant", "needsInformation", "available", "notApplicable"];

function rowStatus(r: Recommendation) {
  if (r.installState === "current") return null;
  if (r.installState !== "notInstalled")
    return <Status tone={installTone[r.installState]}>{installLabel[r.installState]}</Status>;
  if (r.applicability.applicability === "needsInformation")
    return <Status tone="unknown">Needs information</Status>;
  if (r.readiness.state === "missing" && r.applicability.applicability === "applies")
    return <Status tone="warn">Prerequisite missing</Status>;
  return null;
}

/**
 * Why an installed item is here, in its row. It was installed on purpose, so
 * it is not offered "to use manually"; what the match says still shows.
 */
function installedReason(r: Recommendation): string {
  switch (r.applicability.applicability) {
    case "undeclared":
      return "Installed by choice. It has no rules for when it applies.";
    case "doesNotApply":
      return "Installed, though its conditions do not hold here.";
    default:
      return r.applicability.reason;
  }
}

/**
 * Whether an item is listed before any group is expanded: it fits or may
 * fit, or it is installed without rules. When none is, nothing fits yet.
 */
export function fitsProject(r: Recommendation): boolean {
  return r.group !== "notApplicable" && (r.group !== "available" || r.installState !== "notInstalled");
}

export function Workbench({
  overview,
  itemKey,
  openAvailable = false,
}: {
  overview: ProjectOverview;
  itemKey?: string;
  /** Start with the skills to use by hand shown (nothing else fits). */
  openAvailable?: boolean;
}) {
  const { navigate } = useNav();
  const [filter, setFilter] = useState("");
  const [showNotApplicable, setShowNotApplicable] = useState(false);
  const [showAvailable, setShowAvailable] = useState(openAvailable);
  const [review, setReview] = useState<ReviewRequest | null>(null);
  const knowledge = useKnowledge(overview.project.id);
  const listRef = useRef<HTMLDivElement>(null);
  const projectId = overview.project.id;
  const dyes = useDyes();
  // Narrow windows show the list or one item, not both squeezed side by side.
  const narrow = useMedia("(max-width: 1020px)");
  const mode = narrow ? (itemKey ? " is-narrow is-detail" : " is-narrow is-list") : "";
  const toList = () => navigate({ name: "project", projectId, tab: "recommendations" });
  useEffect(() => {
    if (!narrow || !itemKey) return;
    let later: number | undefined;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key !== "Escape" || e.defaultPrevented || target?.closest("input, textarea, [role=dialog]"))
        return;
      // The reader's own Esc (closing a file, then the package) may run after this listener and
      // marks the key as used: back to the list only once every listener has had its turn.
      window.clearTimeout(later);
      later = window.setTimeout(() => {
        if (!e.defaultPrevented) navigate({ name: "project", projectId, tab: "recommendations" });
      }, 0);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(later);
      window.removeEventListener("keydown", onKey);
    };
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

  // What is installed has a section of its own, whatever Habi's match says;
  // the groups below it list what could still be added.
  const installed = visible.filter((r) => r.installState !== "notInstalled");
  const candidates = visible.filter((r) => r.installState === "notInstalled");
  // Items without applicability rules are not recommendations: they are listed only when shown.
  const listed = (r: Recommendation) =>
    filter || fitsProject(r) || (r.group === "notApplicable" ? showNotApplicable : showAvailable);
  const membersOf = (group: Group) => candidates.filter((r) => r.group === group && listed(r));
  // In the order they are drawn: installed first, then each group.
  const navigable = [...installed, ...GROUPS.flatMap(membersOf)];
  const unmatchedByLibrary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of overview.recommendations)
      if (r.group === "available" && r.installState === "notInstalled")
        counts.set(r.item.sourceName, (counts.get(r.item.sourceName) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [overview.recommendations]);
  // An item opened by name is shown even from a collapsed group (which then
  // opens); otherwise the first listed item is, never a hidden one.
  // What is already in the project is listed last, and opens in the same pane.
  const here = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return hereItems(knowledge.data).filter(
      (h) => !q || h.title.toLowerCase().includes(q) || h.gist.toLowerCase().includes(q),
    );
  }, [knowledge.data, filter]);
  const chosenHere = here.find((h) => h.key === itemKey);
  const chosen = overview.recommendations.find((r) => r.item.key === itemKey);
  const selected = chosenHere ? undefined : (chosen ?? navigable[0]);
  const selectedHere = chosenHere ?? (selected ? undefined : here[0]);
  const activeKey = selectedHere?.key ?? selected?.item.key;
  const updatable = overview.recommendations.filter((r) => r.installState === "updateAvailable");
  useEffect(() => {
    // An installed item is in the Installed section, which never folds away.
    if (chosen?.installState !== "notInstalled" || fitsProject(chosen)) return;
    if (chosen.group === "notApplicable") setShowNotApplicable(true);
    else setShowAvailable(true);
  }, [chosen]);

  const open = (key: string) =>
    navigate({ name: "project", projectId, tab: "recommendations", itemKey: key });
  const select = (r: Recommendation) => open(r.item.key);

  const order = [...navigable.map((r) => r.item.key), ...here.map((h) => h.key)];
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "j" && e.key !== "k") return;
    e.preventDefault();
    const index = order.indexOf(activeKey ?? "");
    const next = e.key === "ArrowDown" || e.key === "j" ? index + 1 : index - 1;
    const target = order[Math.max(0, Math.min(order.length - 1, next))];
    if (target) {
      open(target);
      requestAnimationFrame(() => {
        listRef.current?.querySelector<HTMLButtonElement>(`[data-key="${CSS.escape(target)}"]`)?.focus();
      });
    }
  };

  const counts = Object.fromEntries(
    GROUPS.map((g) => [g, candidates.filter((r) => r.group === g).length]),
  ) as Record<Group, number>;

  const row = (r: Recommendation) => {
    const active = r.item.key === activeKey;
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
          <span className="rec-row-reason">
            {r.installState === "notInstalled" ? r.applicability.reason : installedReason(r)}
          </span>
          <span className="rec-row-meta">
            <span className="provenance">
              <Strand dye={dyes(r.item.sourceId)} size={13} />
              {r.item.sourceName}
            </span>
            {/* A plain skill is the default; only the other kinds are worth saying. */}
            {r.item.kind !== "skill" ? <span>{kindLabel[r.item.kind]}</span> : null}
            {r.item.requirement === "required" ? <span>required</span> : null}
          </span>
        </button>
      </li>
    );
  };

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
        {updatable.length > 1 && !filter ? (
          <div className="rec-updates">
            <span>{updatable.length} updates available</span>
            <button
              type="button"
              className="link-btn"
              onClick={() =>
                setReview({
                  kind: "update",
                  keys: updatable.flatMap((r) => (r.installation ? [r.installation.key] : [])),
                  title: `${updatable.length} items`,
                })
              }
            >
              Review all…
            </button>
          </div>
        ) : null}
        {visible.length === 0 && here.length === 0 ? <Empty title="Nothing matches that filter." /> : null}
        {installed.length > 0 ? (
          <section className="rec-group" aria-labelledby="group-installed">
            <header
              className="rec-group-head"
              data-group="installed"
              title="Installed in this project, whatever Habi's match says."
            >
              <span className="rec-group-mark" aria-hidden="true" />
              <h2 id="group-installed" className="rec-group-title">
                Installed
              </h2>
              <span className="rec-group-count">
                {installed.length}
                <span className="visually-hidden"> items</span>
              </span>
            </header>
            <ul className="rec-list">{installed.map(row)}</ul>
          </section>
        ) : null}
        {visible.length === 0 && here.length === 0
          ? null
          : GROUPS.filter((g) => counts[g] > 0).map((group) => {
              const collapsible = (group === "notApplicable" || group === "available") && !filter;
              const shown = group === "notApplicable" ? showNotApplicable : showAvailable;
              const setShown = group === "notApplicable" ? setShowNotApplicable : setShowAvailable;
              const members = membersOf(group);
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
                  {members.length > 0 ? <ul className="rec-list">{members.map(row)}</ul> : null}
                </section>
              );
            })}
        {here.length > 0 ? (
          <section className="rec-group" aria-labelledby="group-here">
            <header className="rec-group-head" data-group="here">
              <span className="rec-group-mark" aria-hidden="true" />
              <h2 id="group-here" className="rec-group-title">
                Already here
              </h2>
              <span className="rec-group-count">
                {here.length}
                <span className="visually-hidden"> items</span>
              </span>
            </header>
            <ul className="rec-list">
              {here.map((h) => {
                const active = h.key === activeKey;
                return (
                  <li key={h.key}>
                    <button
                      type="button"
                      data-key={h.key}
                      className={`rec-row${active ? " is-active" : ""}`}
                      aria-current={active ? "true" : undefined}
                      onClick={() => open(h.key)}
                      onKeyDown={onKeyDown}
                    >
                      <span className="rec-row-top">
                        <span className={`rec-row-title${h.kind === "instructions" ? " mono" : ""}`}>
                          {h.title}
                        </span>
                      </span>
                      <span className="rec-row-reason">{h.gist}</span>
                      <span className="rec-row-meta">
                        <span>{h.kind === "skill" ? "Skill in this project" : "Agent instructions"}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
      <div className="workbench-detail">
        {narrow && itemKey ? (
          <button type="button" className="reader-back workbench-back" onClick={toList}>
            <Icon name="arrowLeft" size={14} />
            Recommendations
          </button>
        ) : null}
        {selectedHere ? (
          <HereDetail key={selectedHere.key} project={overview.project} item={selectedHere} />
        ) : selected ? (
          <ItemDetailPane key={selected.item.key} overview={overview} recommendation={selected} />
        ) : (
          <Empty title="Nothing from your libraries fits this project yet">
            {overview.recommendations.length > 0
              ? "Show the groups on the left to browse what your libraries offer."
              : "Refresh the library or add skills to it."}
          </Empty>
        )}
      </div>
      {review ? (
        <ReviewDialog projectId={projectId} request={review} onClose={() => setReview(null)} />
      ) : null}
    </div>
  );
}
