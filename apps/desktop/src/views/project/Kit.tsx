/**
 * The kit: Habi's short answer to "what should my agents have here?".
 *
 * Every suggestion is a knot on one thread, with the reason it fits and the
 * library it comes from. Libraries not connected yet are connected when the
 * person adds their skills (read only, nothing runs), and adding always ends
 * in the usual review: agents, every file, confirm.
 */
import { useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import type { ItemRef } from "../../bindings/ItemRef";
import type { Kit as KitData } from "../../bindings/Kit";
import type { KitGroup } from "../../bindings/KitGroup";
import type { LibraryIndex } from "../../bindings/LibraryIndex";
import type { ProjectOverview } from "../../bindings/ProjectOverview";
import type { Suggestion } from "../../bindings/Suggestion";
import { Icon } from "../../components/Icon";
import { Button, ErrorNotice } from "../../components/ui";
import { Strand } from "../../components/Weave";
import { Weaving } from "../../components/Weaving";
import { useActions } from "../../lib/actions";
import { api, HabiError, newJobId } from "../../lib/api";
import { type Dye, useDyes } from "../../lib/dye";
import { plural } from "../../lib/format";
import { useNav } from "../../lib/nav";
import { invalidateProjectData, keys } from "../../lib/queries";
import { summarize } from "../../lib/skillFacts";
import { ReviewDialog } from "../review/ReviewDialog";

const SECTIONS: { group: KitGroup; title: string }[] = [
  { group: "required", title: "Your team requires" },
  { group: "stack", title: "For this stack" },
  { group: "practice", title: "For how you work" },
];

/** A library that is not connected yet: a loose, undyed thread. */
const LOOSE: Dye = { color: "var(--ink-faint)", community: true };

/**
 * Who stands behind the reason, when it is not Habi's pick (the kit is
 * Habi's picks unless a row says otherwise).
 */
export function basisWord(s: Suggestion): string | null {
  if (s.group === "required") return "Team requirement";
  if (s.pick) return null;
  switch (s.basis) {
    case "declared":
      return "Author's rule";
    case "catalogHint":
      return "Habi's rule";
    case "described":
      return "From its description";
  }
}

/** Why it fits, in one line: the evaluation's reason, or Habi's stance for a practice. */
export function reasonOf(s: Suggestion): string {
  if (s.applicability && s.applicability.applicability === "applies") return s.applicability.reason;
  return s.pick ?? "";
}

/** Names as a sentence: "Vercel, Sentry and Superpowers". */
function names(list: string[]): string {
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

type Phase =
  | { step: "idle" }
  | { step: "connecting"; name: string; at: number; of: number; job: string }
  | { step: "reading" }
  | { step: "failed"; error: unknown; stopped: boolean }
  | { step: "reviewing"; items: ItemRef[]; missing: string[] };

/**
 * The item a chosen suggestion is, once its library is connected: from the
 * fresh kit, or from the library itself when the kit no longer lists it (a
 * connected library can bring skills that take its place).
 */
async function resolve(
  s: Suggestion,
  fresh: ProjectOverview,
  libraries: Map<string, Promise<LibraryIndex>>,
): Promise<ItemRef | "installed" | null> {
  const now = fresh.kit.suggestions.find((x) => x.key === s.key);
  if (now?.installed) return "installed";
  if (now?.item) return now.item;
  if (s.item) return s.item;
  const source = fresh.sources.find((src) => src.catalogId === s.library.entryId);
  if (!source || !s.library.entryId) return null;
  let library = libraries.get(source.id);
  if (!library) {
    library = api.library(source.id);
    libraries.set(source.id, library);
  }
  const prefix = `catalog:${s.library.entryId}/`;
  const item = (await library).items.find((i) => `${prefix}${i.path}` === s.key);
  return item ? { sourceId: source.id, itemId: item.id } : null;
}

export function Kit({ overview, onAll }: { overview: ProjectOverview; onAll: () => void }) {
  const { project } = overview;
  // While skills are being added the kit holds still: what was chosen is what is added.
  const [frozen, setFrozen] = useState<KitData | null>(null);
  const kit = frozen ?? overview.kit;
  const client = useQueryClient();
  const dyes = useDyes();
  const { navigate } = useNav();
  const { newSkill } = useActions();
  const open = kit.suggestions.filter((s) => !s.installed);
  // Everything is chosen to start with: these are Habi's suggestions, not a menu.
  const [left, setLeft] = useState<Set<string>>(() => new Set());
  const chosen = open.filter((s) => !left.has(s.key));
  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  const cancelled = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const toConnect = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of chosen) {
      if (!s.library.connected && s.library.entryId) seen.set(s.library.entryId, s.library.name);
    }
    return [...seen.entries()].map(([entryId, name]) => ({ entryId, name }));
  }, [chosen]);

  const toggle = (key: string) =>
    setLeft((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const add = async () => {
    const picked = chosen;
    cancelled.current = false;
    setFrozen(kit);
    const items: ItemRef[] = [];
    const missing: string[] = [];
    try {
      for (const [i, library] of toConnect.entries()) {
        const job = newJobId();
        setPhase({ step: "connecting", name: library.name, at: i + 1, of: toConnect.length, job });
        await api.connectCatalogEntry(library.entryId, job);
        if (cancelled.current) throw new HabiError({ code: "cancelled", message: "Stopped before adding." });
      }
      let fresh = overview;
      if (toConnect.length > 0) {
        setPhase({ step: "reading" });
        fresh = await api.projectOverview(project.id, false);
        client.setQueryData(keys.overview(project.id), fresh);
        invalidateProjectData(client);
      }
      const libraries = new Map<string, Promise<LibraryIndex>>();
      for (const s of picked) {
        const found = await resolve(s, fresh, libraries);
        if (found === null) missing.push(s.title);
        else if (found !== "installed") items.push(found);
      }
    } catch (error) {
      if (mounted.current) {
        setPhase({ step: "failed", error, stopped: cancelled.current });
        setFrozen(null);
      }
      // What was connected before the failure stays connected; the kit shows it.
      invalidateProjectData(client);
      return;
    }
    if (!mounted.current) return;
    if (items.length > 0) setPhase({ step: "reviewing", items, missing });
    else {
      setPhase({ step: "idle" });
      setFrozen(null);
    }
  };

  const cancel = () => {
    if (phase.step !== "connecting") return;
    cancelled.current = true;
    void api.cancelJob(phase.job);
  };

  const look = (s: Suggestion) => {
    if (s.item) {
      navigate({
        name: "project",
        projectId: project.id,
        tab: "workbench",
        itemKey: `${s.item.sourceId}/${s.item.itemId}`,
      });
    } else if (s.library.entryId) {
      navigate({ name: "sources", entry: s.library.entryId });
    }
  };

  const busy = phase.step === "connecting" || phase.step === "reading";
  const done = open.length === 0;
  const missing = phase.step === "reviewing" ? phase.missing : [];

  return (
    <div className="kit">
      <div className="kit-grid">
        <div className="kit-list">
          <header className="kit-lead">
            <h2 className="kit-headline">
              {done
                ? `${project.name} has everything Habi suggests`
                : `${plural(open.length, "skill")} for ${project.name}`}
            </h2>
            <p className="kit-sub">
              {done
                ? "New suggestions appear when the project or your libraries change."
                : "Habi's picks for what it read in this repository, each with the reason it fits."}
            </p>
          </header>

          {SECTIONS.map(({ group, title }) => {
            const rows = kit.suggestions.filter((s) => s.group === group);
            if (rows.length === 0) return null;
            return (
              <section key={group} className="kit-section" aria-label={title}>
                <h3 className="kit-section-title">{title}</h3>
                <ul className="kit-rows">
                  {rows.map((s, i) => {
                    const on = !s.installed && !left.has(s.key);
                    const dye = s.library.sourceId ? dyes(s.library.sourceId) : LOOSE;
                    const reason = reasonOf(s);
                    return (
                      <li
                        key={s.key}
                        className={`kit-row${on ? " is-on" : ""}${s.installed ? " is-added" : ""}`}
                        style={{ "--i": i } as CSSProperties}
                      >
                        <label
                          className="kit-knot"
                          data-tip={s.installed ? undefined : on ? "Leave out" : "Add"}
                        >
                          <input
                            type="checkbox"
                            checked={on || s.installed}
                            disabled={s.installed || busy}
                            onChange={() => toggle(s.key)}
                            aria-label={`Add ${s.title}`}
                          />
                          <span className="kit-knot-mark" aria-hidden="true">
                            {s.installed || on ? <Icon name="check" size={11} /> : null}
                          </span>
                        </label>
                        <div className="kit-main">
                          <div className="kit-top">
                            <button type="button" className="kit-title" onClick={() => look(s)}>
                              {s.title}
                            </button>
                            {s.installed ? <span className="kit-added">Added</span> : null}
                            <span
                              className="kit-from"
                              data-tip={
                                s.library.connected
                                  ? `${s.library.name} — connected`
                                  : `${s.library.name} — not connected yet; adding connects it (read only)`
                              }
                            >
                              <Strand dye={dye} size={13} />
                              {s.library.name}
                            </span>
                          </div>
                          {s.gist ? (
                            <p className="kit-gist">{s.pick ? s.gist : summarize(s.gist).text}</p>
                          ) : null}
                          {reason ? (
                            <p className="kit-why">
                              <span className="kit-why-text">{reason}</span>
                              {basisWord(s) ? <span className="kit-basis">{basisWord(s)}</span> : null}
                            </p>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}

          <footer className="kit-foot">
            {kit.more > 0 ? (
              <button type="button" className="kit-link" onClick={onAll}>
                {plural(kit.more, "more skill")} from your libraries {kit.more === 1 ? "fits" : "fit"}
                <Icon name="chevronRight" size={12} />
              </button>
            ) : null}
            <button
              type="button"
              className="kit-link"
              onClick={() => newSkill({ projectId: project.id, projectName: project.name })}
            >
              Write a skill for how {project.name} works
              <Icon name="chevronRight" size={12} />
            </button>
          </footer>
        </div>

        {done ? null : (
          <aside className="kit-cart" aria-label={`Add to ${project.name}`}>
            <p className="kicker">Add to {project.name}</p>
            <p className="kit-cart-count">
              {chosen.length === 0 ? "Nothing chosen" : plural(chosen.length, "skill")}
            </p>
            {toConnect.length > 0 ? (
              <div className="kit-connects">
                <p className="kit-cart-note">
                  Connects {toConnect.length === 1 ? "this library" : `these ${toConnect.length} libraries`}{" "}
                  first. Read only, nothing runs.
                </p>
                <ul className="kit-threads" aria-hidden="true">
                  {toConnect.map((l) => (
                    <li
                      key={l.entryId}
                      className={phase.step === "connecting" && phase.name === l.name ? "is-now" : undefined}
                    >
                      <Strand dye={LOOSE} size={13} />
                      {l.name}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {phase.step === "connecting" ? (
              <Weaving
                slim
                label={`Connecting ${phase.name}`}
                hint={phase.of > 1 ? `${phase.at} of ${phase.of}` : undefined}
                onCancel={cancel}
              />
            ) : phase.step === "reading" ? (
              <Weaving slim label="Finding the skills in what was connected" />
            ) : (
              <Button
                variant="primary"
                className="kit-go"
                disabled={chosen.length === 0}
                onClick={() => void add()}
              >
                {chosen.length === 0 ? "Choose skills to add" : `Add ${plural(chosen.length, "skill")}…`}
              </Button>
            )}
            {phase.step === "failed" ? (
              <ErrorNotice
                error={phase.error}
                title={phase.stopped ? "Stopped before adding" : "A library could not be connected"}
              />
            ) : null}
            {missing.length > 0 ? (
              <p className="kit-cart-note is-warn">
                Not in its library any more: {names(missing)}. The rest are in the review.
              </p>
            ) : null}
            <p className="kit-cart-note">
              You choose the agents and see every file before anything is written.
            </p>
          </aside>
        )}
      </div>

      {phase.step === "reviewing" ? (
        <ReviewDialog
          projectId={project.id}
          request={{
            kind: "install",
            items: phase.items,
            title: plural(phase.items.length, "skill"),
          }}
          onClose={() => {
            setPhase({ step: "idle" });
            setFrozen(null);
            setLeft(new Set());
          }}
        />
      ) : null}
    </div>
  );
}
