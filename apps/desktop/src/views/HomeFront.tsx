/**
 * Home as a front page: the project that needs you most is the headline, with
 * the skills it is missing and the one action to take. Down the side, what comes
 * after it: only the projects with skills waiting, most first. The sidebar already
 * lists every project; this says what to do next.
 *
 * One line is the page's only ornament, and it is a count: pulled straight for each
 * skill installed, one soft wave for each still waiting, tied off in a knot.
 */
import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import type { ProjectOverview } from "../bindings/ProjectOverview";
import { tip } from "../components/Tooltips";
import { Button } from "../components/ui";
import { api } from "../lib/api";
import { andList, plural } from "../lib/format";
import { useNav } from "../lib/nav";
import { keys } from "../lib/queries";

/** Something that waits on the person and belongs to no project's count, and the way to it. */
export type HomeNote = { key: string; name: string; detail: string; go: () => void };

export type HomeProject = {
  id: string;
  name: string;
  /** Per library: titles installed here, and how many more of its skills fit. Absent until matched. */
  threads: { sourceId: string; sourceName: string; installed: string[]; loose: number }[] | null;
  when: string;
  open: () => void;
};

const WORDS = [
  "No",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
];
const SHOWN_SKILLS = 3;
const SHOWN_AFTER = 6;
const LINE_WIDTH = 640;
const LINE_Y = 14;
/** Length of one skill on the line, shorter when there are many so it stays on the page. */
const UNIT = 56;

const installedIn = (p: HomeProject) => (p.threads ?? []).reduce((n, t) => n + t.installed.length, 0);
const looseIn = (p: HomeProject) => (p.threads ?? []).reduce((n, t) => n + t.loose, 0);

/** The one that needs you most: the most skills waiting, the most recently opened on a tie. */
function leadOf(projects: HomeProject[]): HomeProject | undefined {
  return projects.reduce<HomeProject | undefined>(
    (best, p) => (!best || looseIn(p) > looseIn(best) ? p : best),
    undefined,
  );
}

function headline(p: HomeProject): string {
  const loose = looseIn(p);
  const count = WORDS[loose] ?? String(loose);
  if (!p.threads) return "Habi has not looked at this project yet.";
  if (loose === 0)
    return installedIn(p) > 0
      ? "Everything that fits is installed."
      : "Nothing from your libraries fits yet.";
  const skills = loose === 1 ? "skill fits" : "skills fit";
  return installedIn(p) === 0
    ? `${count} ${skills} this project, and none are added yet.`
    : `${count} more ${skills} this project.`;
}

/** Straight for what is installed, a wave for each skill waiting, a knot where it ends. */
function Line({ project }: { project: HomeProject }) {
  const installed = installedIn(project);
  const loose = looseIn(project);
  const total = installed + loose;
  if (total === 0) return <span className="front-line-space" aria-hidden="true" />;
  const unit = Math.min(UNIT, (LINE_WIDTH - 12) / total);
  const taut = installed * unit;
  let slack = `M${taut} ${LINE_Y}`;
  for (let k = 0; k < loose; k++) {
    const from = taut + k * unit;
    // Each wave a little different, as a thread left to hang would be.
    const rise = (k % 2 === 0 ? -1 : 1) * (6 + ((k * 7) % 4));
    slack += `C${from + unit * 0.3} ${LINE_Y + rise} ${from + unit * 0.7} ${LINE_Y + rise} ${from + unit} ${LINE_Y}`;
  }
  const end = total * unit;
  return (
    <svg className="front-line" viewBox={`0 0 ${LINE_WIDTH} 28`} aria-hidden="true" focusable="false">
      {taut > 0 ? (
        <line x1={0} y1={LINE_Y} x2={taut} y2={LINE_Y} className="front-line-taut" pathLength={1} />
      ) : null}
      {loose > 0 ? <path d={slack} className="front-line-slack" pathLength={1} /> : null}
      <circle
        cx={end}
        cy={LINE_Y}
        r={4}
        className={loose > 0 ? "front-line-knot" : "front-line-knot is-done"}
      />
    </svg>
  );
}

/** Long names break after their hyphens, and read the same when copied. */
function Breakable({ name }: { name: string }) {
  const parts = name.split("-");
  return (
    <>
      {parts.map((part, k) => (
        <Fragment key={k}>
          {part}
          {k < parts.length - 1 ? (
            <>
              -<wbr />
            </>
          ) : null}
        </Fragment>
      ))}
    </>
  );
}

function Lead({ project, onExplore }: { project: HomeProject; onExplore: () => void }) {
  const { navigate } = useNav();
  const loose = looseIn(project);
  const overview = useQuery<ProjectOverview>({
    queryKey: keys.overview(project.id),
    queryFn: () => api.projectOverview(project.id, false),
    enabled: loose > 0,
    staleTime: 60_000,
    retry: false,
  });
  const waiting = (overview.data?.recommendations ?? [])
    .filter((r) => r.installState === "notInstalled" && r.applicability.applicability === "applies")
    .sort((a, b) => Number(b.group === "required") - Number(a.group === "required"))
    .slice(0, SHOWN_SKILLS);
  return (
    <section className="front-lead" aria-labelledby="front-lead-title">
      <p className="front-kicker">{loose > 0 ? "Next up" : "Most recent"}</p>
      <h1 id="front-lead-title" className="front-title">
        <button type="button" onClick={project.open}>
          <Breakable name={project.name} />
        </button>
      </h1>
      <p className="front-deck">{headline(project)}</p>
      <Line project={project} />
      {waiting.length > 0 ? (
        <ul className="front-skills">
          {waiting.map((r) => (
            <li key={r.item.key}>
              <button
                type="button"
                onClick={() =>
                  navigate({ name: "project", projectId: project.id, tab: "workbench", itemKey: r.item.key })
                }
              >
                <span className="front-skill-name">{r.item.title}</span>{" "}
                <span className="front-skill-why">
                  {r.group === "required" ? "Your team requires it" : r.applicability.reason}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="front-act">
        {loose > 0 ? (
          <Button variant="primary" onClick={project.open}>
            Review {plural(loose, "skill")}…
          </Button>
        ) : project.threads && installedIn(project) === 0 ? (
          <Button variant="primary" onClick={onExplore}>
            Explore libraries
          </Button>
        ) : (
          <Button variant="primary" onClick={project.open}>
            Open {project.name}
          </Button>
        )}
      </div>
    </section>
  );
}

function stateOf(p: HomeProject): { text: string; waiting: boolean } {
  if (!p.threads) return { text: "Not looked at yet", waiting: false };
  const installed = installedIn(p);
  const loose = looseIn(p);
  if (installed === 0 && loose === 0) return { text: "Nothing fits yet", waiting: false };
  if (installed === 0)
    return { text: `${plural(loose, "skill")} ${loose === 1 ? "fits" : "fit"}, none added`, waiting: true };
  if (loose === 0) return { text: `${installed} installed`, waiting: false };
  return { text: `${installed} installed, ${loose} more ${loose === 1 ? "fits" : "fit"}`, waiting: false };
}

export function HomeFront({
  projects,
  also = [],
  onOpenAnother,
  onExplore,
}: {
  projects: HomeProject[];
  /** What waits but belongs to no project's count. */
  also?: HomeNote[];
  onOpenAnother: () => void;
  onExplore: () => void;
}) {
  const lead = leadOf(projects);
  if (!lead) return null;
  const after = projects
    .filter((p) => p.id !== lead.id && looseIn(p) > 0)
    .sort((a, b) => looseIn(b) - looseIn(a));
  return (
    <div className="front">
      <Lead key={lead.id} project={lead} onExplore={onExplore} />
      <aside className="front-rail" aria-label="After that">
        {after.length > 0 || also.length > 0 ? <p className="front-kicker">After that</p> : null}
        <ul>
          {after.slice(0, SHOWN_AFTER).map((p) => {
            const state = stateOf(p);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={p.open}
                  data-tip-side="top"
                  {...tip({
                    title: p.name,
                    lines: [
                      ...(p.threads ?? []).flatMap((t) => [
                        ...(t.installed.length > 0
                          ? [{ text: `${t.sourceName}: ${andList(t.installed)}` }]
                          : []),
                        ...(t.loose > 0
                          ? [{ text: `${t.sourceName}: ${t.loose} more ${t.loose === 1 ? "fits" : "fit"}` }]
                          : []),
                      ]),
                      { text: `opened ${p.when}`, mono: true },
                    ],
                  })}
                >
                  <span className="front-rail-name">{p.name}</span>{" "}
                  <span className={`front-rail-state${state.waiting ? " is-waiting" : ""}`}>
                    {state.text}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {after.length > SHOWN_AFTER ? (
          <p className="front-more">and {after.length - SHOWN_AFTER} more</p>
        ) : null}
        {also.length > 0 ? (
          <section className="front-also" aria-label="Also waiting">
            {also.map((n) => (
              <button key={n.key} type="button" onClick={n.go}>
                {n.name} {n.detail}
              </button>
            ))}
          </section>
        ) : null}
        <button type="button" className="link-quiet front-another" onClick={onOpenAnother}>
          Open another project…
        </button>
      </aside>
    </div>
  );
}
